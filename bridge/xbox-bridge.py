#!/usr/bin/env python3
"""
xbox-bridge.py — feed ANY camera into the Xbox Tracking System.

Use this for cameras a browser cannot reach: IP/RTSP cams, USB webcams on a
Raspberry Pi, an NVR sub-stream, or a file. It runs the same two signals the
web node uses — frame-difference motion and (optionally) a person detector —
and posts alerts to the ingest endpoint:

    POST https://xboxsystem.vercel.app/api/event   x-xbox-token: <token>

Examples
--------
# USB webcam on a Pi, motion alerts only, 5 checks/second:
python3 xbox-bridge.py --source 0 --endpoint https://xboxsystem.vercel.app/api/event \
        --token "$XBOX_INGEST_TOKEN" --camera "Garage" --fps 5

# RTSP IP camera, with the OpenCV pedestrian detector (skeleton is not produced
# by this bridge, but person counts + boxes are) and evidence frames:
python3 xbox-bridge.py --source rtsp://user:pass@192.168.1.44:554/stream1 \
        --endpoint https://xboxsystem.vercel.app/api/event --token "$XBOX_INGEST_TOKEN" \
        --camera "Yard" --person --snapshot --cooldown 30 --sensitivity 0.55

Dependencies: pip install opencv-python numpy   (no other packages — HTTP is stdlib)
"""

from __future__ import annotations

import argparse
import base64
import json
import signal
import sys
import time
import urllib.error
import urllib.request

import cv2  # type: ignore
import numpy as np  # type: ignore

STOP = False


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Xbox Tracking System camera bridge")
    p.add_argument("--source", default="0", help="index (0), device path, image, or rtsp/http(s) URL")
    p.add_argument("--endpoint", default="https://xboxsystem.vercel.app/api/event")
    p.add_argument("--token", default="", help="XBOX_INGEST_TOKEN or this node's access token")
    p.add_argument("--camera", default="bridge node", help="node label; created if it does not exist")
    p.add_argument("--fps", type=float, default=5.0, help="analysis rate (1-15 sensible)")
    p.add_argument("--motion-threshold", type=float, default=0.014, help="changed-pixel ratio that counts as motion")
    p.add_argument("--sensitivity", type=float, default=0.5, help="min detector confidence to count a person")
    p.add_argument("--cooldown", type=float, default=25.0, help="seconds between repeat alerts")
    p.add_argument("--person", action="store_true", help="enable OpenCV person detection (HOG or YOLO if provided)")
    p.add_argument("--cascades", default="", help="optional path to a person Haar/XML or ONNX model")
    p.add_argument("--snapshot", action="store_true", help="attach a JPEG evidence frame to each alert")
    p.add_argument("--width", type=int, default=480, help="analysis width")
    p.add_argument("--no-verify", action="store_true", help="keep trying after uplink errors")
    return p.parse_args()


class Motion:
    """EMA background model on a small grayscale proxy — same idea as src/motion.js."""

    def __init__(self, width: int = 96, height: int = 72, floor: int = 22):
        self.size = (width, height)
        self.floor = floor
        self.bg: np.ndarray | None = None

    def update(self, frame: np.ndarray) -> dict:
        small = cv2.cvtColor(cv2.resize(frame, self.size), cv2.COLOR_BGR2GRAY)
        if self.bg is None:
            self.bg = small.astype(np.float32)
            return {"ratio": 0.0, "active": False, "box": None}
        diff = np.abs(small.astype(np.float32) - self.bg)
        mask = (diff > self.floor).astype(np.uint8)
        ratio = float(mask.sum()) / float(mask.size)
        box = None
        if mask.sum() > 6:
            ys, xs = np.nonzero(mask)
            box = [
                round(float(xs.min()) / self.size[0], 4),
                round(float(ys.min()) / self.size[1], 4),
                round(float(xs.max() - xs.min() + 1) / self.size[0], 4),
                round(float(ys.max() - ys.min() + 1) / self.size[1], 4),
            ]
        flag = mask.astype(bool)
        self.bg[flag] = 0.5 * self.bg[flag] + 0.5 * small[flag]
        self.bg[~flag] = 0.955 * self.bg[~flag] + 0.045 * small[~flag]
        return {"ratio": round(ratio, 5), "active": False, "box": box}


class PersonDetector:
    def __init__(self, model_path: str = ""):
        self.hog = cv2.HOGDescriptor()
        self.hog.setSVMDetector(cv2.HOGDescriptor_getDefaultPeopleDetector())
        self.cascade = None
        if model_path:
            c = cv2.CascadeClassifier(model_path)
            if not c.empty():
                self.cascade = c
            else:
                print(f"warn: could not load cascade {model_path}, using HOG", file=sys.stderr)

    def detect(self, frame: np.ndarray):
        """Return [(x, y, w, h) normalised, confidence] with weight-loss style NMS."""
        if self.cascade is not None:
            gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            found = self.cascade.detectMultiScale(gray, scaleFactor=1.06, minNeighbors=4, minSize=(40, 70))
            h, w = frame.shape[:2] or (1, 1)
            return [([x / w, y / h, bw / w, bh / h], 0.7) for (x, y, bw, bh) in list(found)]
        boxes, weights = self.hog.detectMultiScale(frame, winStride=(6, 6), padding=(8, 8), scale=1.055)
        h, w = frame.shape[:2]
        picked = non_max_suppression(np.array([list(b) for b in boxes], dtype=float) if len(boxes) else np.zeros((0, 4)), np.array(weights).ravel())
        return [([bx / w, by / h, bw / w, bh / h], float(conf)) for (bx, by, bw, bh, conf) in picked]


def non_max_suppression(boxes: np.ndarray, scores: np.ndarray, overlap: float = 0.45):
    if boxes.size == 0:
        return []
    x1, y1 = boxes[:, 0], boxes[:, 1]
    x2, y2 = boxes[:, 0] + boxes[:, 2], boxes[:, 1] + boxes[:, 3]
    area = (x2 - x1) * (y2 - y1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0, xx2 - xx1) * np.maximum(0, yy2 - yy1)
        iou = inter / (area[i] + area[order[1:]] - inter)
        order = order[1:][iou <= overlap]
    return [(boxes[k][0], boxes[k][1], boxes[k][2], boxes[k][3], float(scores[k])) for k in keep]


def post(url: str, token: str, payload: dict, timeout: float = 12.0) -> tuple[int, str]:
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={"content-type": "application/json", "x-xbox-token": token, "user-agent": "xbox-bridge/1.0"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "ignore")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "ignore")
    except Exception as e:  # network / TLS / DNS
        return 0, str(e)


def open_source(src: str) -> cv2.VideoCapture:
    cap = cv2.VideoCapture(int(src) if src.isdigit() else src)
    if src.startswith("rtsp"):
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
    return cap


def main() -> int:
    global STOP
    a = parse_args()

    def bye(*_):
        global STOP
        STOP = True

    signal.signal(signal.SIGINT, bye)
    signal.signal(signal.SIGTERM, bye)

    cap = open_source(a.source)
    if not cap.isOpened():
        print(f"error: cannot open camera source {a.source!r}", file=sys.stderr)
        return 2
    motion = Motion(width=a.width // 5 or 96)
    detector = PersonDetector(a.cascades) if a.person else None
    state = "clear"
    since_enter = 0.0
    last_alert = 0.0
    pending = 0
    sent = 0
    period = 1.0 / max(0.5, min(a.fps, 15.0))
    print(f"xbox-bridge → {a.endpoint} as “{a.camera}” @ {1/period:.1f} fps (motion gate {a.motion_threshold})")

    while not STOP:
        t0 = time.time()
        ok, frame = cap.read()
        if not ok:
            print("warn: frame grab failed, retrying…", file=sys.stderr)
            time.sleep(1.0)
            continue

        m = motion.update(frame)
        persons = []
        if detector is not None:
            persons = [p for p in detector.detect(frame) if p[1] >= a.sensitivity]
        count = len(persons)
        has_person = count > 0
        moving = m["ratio"] > a.motion_threshold
        if moving:
            pending += 1
        else:
            pending = 0
        moving = pending >= 2

        event = None
        now = time.time()
        if has_person or moving:
            if state == "clear":
                state = "person" if has_person else "motion"
                since_enter = now
                event = "person" if has_person else "motion"
            elif now - last_alert >= a.cooldown:
                event = "person+motion" if (has_person and moving) else ("person" if has_person else "motion")
                state = "person" if has_person else "motion"
            if has_person:
                state = "person"
        elif state != "clear" and now - since_enter > 3.0:
            state = "clear"
            event = "presence-gone"

        if event:
            last_alert = now
            payload = {
                "camera_label": a.camera,
                "kind": "bridge",
                "session_id": f"bridge-{int(since_enter)}",
                "event_type": event,
                "person_count": count,
                "confidence": round(max([p[1] for p in persons], default=0.0), 3),
                "motion_score": m["ratio"],
                "bbox": persons[0][0] and {"x": persons[0][0][0], "y": persons[0][0][1], "w": persons[0][0][2], "h": persons[0][0][3]},
                "engine": "opencv-bridge",
                "fps": round(1.0 / period, 1),
                "device": f"python/{sys.version_info.major}.{sys.version_info.minor}@{time.strftime('%Z')}",
                "meta": {"duration_s": round(now - since_enter, 1)},
            }
            if a.snapshot and event != "presence-gone":
                jpg = cv2.imencode(".jpg", cv2.resize(frame, (0, 0), fx=760 / frame.shape[1], fy=760 / frame.shape[1]), [int(cv2.IMWRITE_JPEG_QUALITY), 62])[1]
                payload["snapshot"] = "data:image/jpeg;base64," + base64.b64encode(jpg.tobytes()).decode()
            code, body = post(a.endpoint, a.token, payload)
            if 200 <= code < 300:
                sent += 1
                print(f"{time.strftime('%H:%M:%S')} {event:14s} persons={count} motion={m['ratio']:.4f} → {code}")
            else:
                print(f"error {code}: {body[:200]}", file=sys.stderr)
                if not a.no_verify:
                    print("hint: check --token / --endpoint, or pass --no-verify to keep running", file=sys.stderr)
                    return 3

        if a.snapshot and (has_person or moving) and time.time() % 5 < period:
            pass  # frames are only shipped with alerts to keep mobile data sane

        elapsed = time.time() - t0
        time.sleep(max(0.0, period - elapsed))

    cap.release()
    print(f"stopped. {sent} alert(s) sent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
