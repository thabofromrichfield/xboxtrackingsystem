# Xbox Tracking System — person (skeleton) + motion detection

Point any camera at a room. The system watches the video locally, detects **people as a 33-point skeleton**
and **motion** even when no skeleton can be locked, and pushes an alert to a **control center** that you keep
open on a laptop/tablet/phone. Backend is Supabase, frontend is hosted on Vercel.

```
┌────────────────────────────┐   frames never leave the device   ┌──────────────────────────┐
│ CAMERA NODE  /camera       │                                   │ CONTROL CENTER  /        │
│ getUserMedia (phone cam,   │  alert row + evidence JPEG        │ live alert feed          │
│ webcam, tablet, old phone) │  ────────────────────────────►    │ banner + siren           │
│  ├ MediaPipe PoseLandmarker│        Supabase (this project)    │ camera wall + skeletons  │
│  │   33-pt skeleton        │   • xbox_detection_events         │ arm / disarm, tune       │
│  └ motion sensor (frame    │   • xbox_cameras (config+hb)      │ acknowledge, 24h activity│
│    difference, always on)  │   • realtime ◄────────────────────│                          │
└────────────────────────────┘   • xbox-snapshots (evidence)     └──────────────────────────┘
            ▲                                                          ▲
            │ POST /api/event (token)                                  │ same endpoint
   any other camera: IP/RTSP cam, Raspberry Pi, ESP32, NVR, curl ──────┘
```

| Piece | Where | Notes |
| --- | --- | --- |
| Control center | https://xboxsystem-kappa.vercel.app/ (also `xboxsystem-lesegomoima.vercel.app`) | Vercel project **`xboxsystem`** |
| Camera node | https://xboxsystem-kappa.vercel.app/camera | needs HTTPS for `getUserMedia` |
| REST ingest | `POST https://xboxsystem-kappa.vercel.app/api/event` | Vercel serverless function |
| Backend | Supabase project `xboxtracking` → ref **`gfshxhqzsexpsahnuwkw`** (eu-west-1) | "xbox system" project |
| Repo | `thabofromrichfield/xboxtrackingsystem` | Vercel is linked to this repo |

---

## 1. Use it with your phone (the normal case)

1. Open **`/camera`** on the phone → allow camera.
2. Name the node (e.g. `Living room`) → **Start monitoring**. That registers the node in Supabase and starts
   analysing frames at the chosen rate (default 8 fps).
3. Open **`/`** on any other device. It is already linked to the same Supabase project, so alerts from that
   phone appear within ~1s (Realtime) or ~2.5s (polling fallback).

Convenience: the control center's **＋ Add camera node** button registers a node and prints a link + QR code —
scan it with the phone, press Start, done. On iPhone/Android use *Add to Home Screen* on the node page and it
behaves like a kiosk app. Tick **keep screen awake** (Wake Lock API) for long sessions.

Detected person ⇒ alert row `person` (or `person+motion` when they are also moving fast), a snapshot is
uploaded, the control center lights up with a siren. When the frame empties ⇒ `presence-gone` (shown as
*frame cleared*). Partial bodies, or a phone that cannot run the model, still alert via `motion`.

## 2. How detection works

**Person skeleton** — `src/pose.js` loads `@mediapipe/tasks-vision` `PoseLandmarker` (lite/full/heavy, chosen in
the UI) from a CDN at runtime with GPU delegate → CPU fallback. Detections are scored by upper-body landmark
visibility + body size (`src/skeleton.js → coreConfidence`). Landmarks are stored, not just boxes: the control
center redraws the skeleton over the evidence frame from `skeleton.pts` in the database.

**Motion** — `src/motion.js` keeps a 96×72 grayscale proxy frame, an EMA background model (so slow light
changes, curtains, TV flicker don't trip it) plus a frame-to-frame requirement, and returns change ratio, blob
count and a bounding box. This runs whether or not the model loaded, so the system never becomes blind.

**Decision logic** — `src/watcher.js` is the only thing that may raise an alert:

| situation | event emitted | notes |
| --- | --- | --- |
| skeleton locked ≥ gate | `person` | immediate, one frame is enough |
| skeleton locked **and** motion strong | `person+motion` | priority event |
| motion only, 2 consecutive frames | `motion` | debounced; specks ignored (< 5 px cells) |
| someone stays in frame | repeats every `cooldown_seconds` | so an occupied room keeps alerting |
| person leaves for 7 frames | `presence-gone` | severity `clear` |
| node disarmed | detection shown, `is_alert = false` | armed lives in the DB row |

Gates: `sensitivity` (default 0.45 skeleton confidence), `motion_threshold` (default 0.012 ≈ 1.2 % of pixels
changed), `cooldown_seconds` (default 20). **All three are stored per node in Supabase, so you can retune from
the control center** — the node pulls them every 12s and logs what changed.

## 3. Backend — Supabase `gfshxhqzsexpsahnuwkw`

Applied as migration `create_xbox_detection_system`; the readable copy is
[`sql/schema.sql`](sql/schema.sql) (re-apply it verbatim to clone the system elsewhere).

* **`xbox_cameras`** — one row per node: `label, location, kind, access_token, armed, sensitivity,
  motion_threshold, cooldown_seconds, capture_snapshots, max_fps, status, engine, fps_reported, persons_last,
  last_heartbeat_at, last_event_at, archived`.
* **`xbox_detection_events`** — the alert log: `event_type, severity, person_count, confidence, motion_score,
  bbox, skeleton(jsonb), snapshot_url, engine, fps, device, is_alert, acknowledged_at, meta, session_id`.
  Indexes on `(camera_id, created_at desc)`, `(created_at desc)` and a partial index on `is_alert`.
* **Triggers** — `severity` and `is_alert` are derived server-side from the node's `armed` state, and
  `xbox_cameras.last_event_at / persons_last` roll up from the inserted event. A camera keeps its last known
  person count even if the node row is deleted (`on delete set null` + denormalised `camera_label`).
* **RPCs** — `xbox_register_camera` (idempotent per label, returns `id` + `access_token`), `xbox_heartbeat`,
  `xbox_mark_ack`, `xbox_purge_events`, `xbox_sweep_stale` (offline sweep), `xbox_housekeeping`.
  They are `security definer`, so a device needs no table-level write grants.
* **Realtime** — both tables are in the `supabase_realtime` publication (inserts on events, inserts/updates on
  cameras, so node state and config changes propagate instantly).
* **Storage** — public bucket `xbox-snapshots`, 4 MB limit, JPEG/PNG only, objects under
  `xbox/{cameraId}/{sessionId}/{stamp}.jpg`; write policies require that `xbox/` prefix.

RLS (single-tenant device mode): read on both tables, `insert` on events only for an existing un-archived
camera, `update` allowed (dashboard tuning + acknowledge), no delete for `anon`. Registration/heartbeat go
through the definer RPCs. The **publishable** key is baked into the bundle as a default (`src/config.js`) and can
be overridden at runtime in ⚙ Settings; the **service-role** key exists only as a Vercel env var for the ingest
function.

## 4. Any other camera (IP cam, RTSP, Raspberry Pi, ESP32, NVR)

`api/event.js` is a Vercel function that ingests for non-browser devices. It authenticates with
`XBOX_INGEST_TOKEN`, resolves/creates the node, uploads an optional inline base64 evidence frame to Storage and
writes the event with the service-role key — devices never see a database key.

```bash
curl -sS -X POST https://xboxsystem-kappa.vercel.app/api/event \
  -H 'content-type: application/json' \
  -H "x-xbox-token: $XBOX_INGEST_TOKEN" \
  -d '{"camera_label":"Garage","kind":"ip-cam","event_type":"person","person_count":1,
       "confidence":0.87,"motion_score":0.041,"engine":"ipcam-haarcascade","device":"pi4",
       "bbox":{"x":0.31,"y":0.18,"w":0.28,"h":0.63}}'
# → {"ok":true,"camera_id":"…","event":{"id":42,"severity":"person","is_alert":true,…}}
```

`GET /api/event` returns a health probe (`project`, `token_required`, …) — handy to verify the env wiring.
You can also send `"snapshot": "data:image/jpeg;base64,…"`, `"skeleton": {"poses":[{"pts":[[x,y,vis],…]}]}`
(real landmark arrays will render on the control center), `"session_id"`, or `"camera_id"` to skip label lookup.

Bundled bridge for an actual video stream — `pip install opencv-python numpy`, then:

```bash
python3 bridge/xbox-bridge.py --source rtsp://user:pass@192.168.1.44:554/stream1 \
  --endpoint https://xboxsystem-kappa.vercel.app/api/event \
  --token "$XBOX_INGEST_TOKEN" --camera "Yard" --person --snapshot --fps 5 --cooldown 30
```

It runs the same idea as the browser node (EMA frame-difference motion + OpenCV HOG/Haar person boxes),
debounces, re-alerts on a cooldown and posts `presence-gone` when the scene empties.

Vercel env vars on `xboxsystem`: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (encrypted), `XBOX_INGEST_TOKEN`
(encrypted), `XBOX_AUTO_REGISTER=true`, `XBOX_SNAPSHOT_BUCKET=xbox-snapshots`.

## 5. Local development

No build step, on purpose — the app is native ES modules and the detection engines come from CDN at runtime, so
what you run is byte-for-byte what deploys (a bundler can never break this deploy).

```bash
python3 tools/serve.py 5173      # serves /, /camera (mirrors Vercel routing), mocks POST /api/event
node --test tests/detection-logic.test.mjs   # 11 tests: state machine, skeleton packing, gates
```

`tools/serve.py` also sends the headers the camera API expects. On a phone over LAN, `getUserMedia` needs HTTPS
or `localhost` — tunnel with `cloudflared`/`ngrok` if you want to test the mobile camera locally.

## 6. Redeploy

Vercel is connected to this repository, so a push to a branch with an open PR builds automatically; `main` is the
production branch. To publish right now: `git push` (PR #1 branch) → the deployment updates within ~30 s, or
merge PR #1 to make `main` carry it. `vercel.json` pins `outputDirectory: "."`, disables the build step and
declares the `api/event.js` function (256 MB / 30 s).

## 7. Tuning, privacy and limits

* **False alerts from a TV/window** → raise *motion gate* and *person gate*; the motion sensor already needs both
  background-residual **and** frame-to-frame change, and blobs under 5 coarse cells are ignored.
* **Missed person at night / far away** → lower the gate to ~0.25 and pick the `full`/`heavy` model; a far-away
  person has a small skeleton, so `coreConfidence` scales with body size.
* **Battery/heat on a phone** → drop analysis fps to 3–5; detection stays reliable because the state machine
  debounces over frames, not wall-clock.
* **Privacy** — video is analysed in the browser and only alert rows + (optionally) one JPEG per alert are stored;
  turn *upload evidence frame* off per node for zero image retention. Snapshots are a public-read bucket, so
  keep the URL private or disable snapshots for sensitive rooms. 30-day retention is enforced by
  `xbox_housekeeping` / `xbox_purge_events`.
* **Hardening path** (if you ever expose this beyond your own devices): add Supabase Auth and swap the permissive
  `anon` policies for `authenticated` ones, move the model assets into Storage to drop the CDN dependency, and
  wire `xbox_housekeeping` to `pg_cron` (not enabled on this project — the control center calls it every 25 s
  instead).

### Troubleshooting

| symptom | fix |
| --- | --- |
| camera never opens | page must be HTTPS (or `localhost`); iOS: *aA* → Website Settings → Camera → Allow, then reload |
| "camera is busy" | another app holds it (Camera/Zoom/another tab) |
| `skeleton model unavailable …` in the node log | CDN blocked (jsdelivr/unpkg/gstatic); motion-only mode still alerts |
| no alerts on the dashboard | node must be **armed**; check the chip row (`uplink`, `node`) and `xbox_cameras.last_heartbeat_at` |
| events stay in "queued" | device lost network — the node retries every 4s, up to 250 events |
| blank page on Vercel | project is deployed; wait ~30s after a push, then check `vercel.com/lesegomoima/xboxsystem` |
