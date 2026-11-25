-- =============================================================================
-- Xbox Tracking System — Supabase schema (source of truth)
-- Project: "xbox system"  →  ref gfshxhqzsexpsahnuwkw  (eu-west-1)
-- Applied as migration `create_xbox_detection_system`. Re-apply on a new
-- project with:  psql / Supabase SQL editor / supabase db push
-- =============================================================================

-- ---------------------------------------------------------------- camera nodes
create table if not exists public.xbox_cameras (
  id                uuid primary key default gen_random_uuid(),
  label             text not null,
  location          text,
  kind              text not null default 'mobile'
                    check (kind in ('mobile','webcam','ip-cam','rtsp','bridge','other')),
  access_token      text not null default replace(gen_random_uuid()::text,'-',''),
  armed             boolean not null default true,
  sensitivity       numeric(4,3) not null default 0.500 check (sensitivity between 0 and 1),
  motion_threshold  numeric(5,3) not null default 0.012 check (motion_threshold between 0 and 1),
  cooldown_seconds  integer  not null default 20 check (cooldown_seconds between 0 and 3600),
  capture_snapshots boolean not null default true,
  max_fps           integer  not null default 8 check (max_fps between 1 and 60),
  status            text not null default 'offline' check (status in ('online','offline','degraded')),
  engine            text,
  fps_reported      numeric(6,2),
  persons_last      integer not null default 0,
  last_heartbeat_at timestamptz,
  last_event_at     timestamptz,
  notes             text,
  archived          boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------------------------------------------------------------- detection log
create table if not exists public.xbox_detection_events (
  id              bigint generated always as identity primary key,
  camera_id       uuid references public.xbox_cameras(id) on delete set null,
  camera_label    text,
  session_id      text,
  event_type      text not null check (event_type in ('person','person+motion','motion','presence-gone','info','test')),
  severity        text not null default 'info' check (severity in ('person','motion','clear','info')),
  person_count    integer not null default 0,
  confidence      numeric(4,3),
  motion_score    numeric(6,4),
  bbox            jsonb,          -- normalised 0..1 {x,y,w,h} of the person/motion region
  skeleton        jsonb,          -- {v,model,poses:[{score,box,pts:[[x,y,vis] x33]}]}
  snapshot_url    text,          -- public Storage object with the evidence frame
  engine          text,
  fps             numeric(6,2),
  device          text,
  is_alert        boolean not null default false,
  acknowledged_at timestamptz,
  acknowledged_by text,
  meta            jsonb,
  created_at      timestamptz not null default now()
);

create index if not exists xbox_events_camera_time_idx on public.xbox_detection_events (camera_id, created_at desc);
create index if not exists xbox_events_time_idx         on public.xbox_detection_events (created_at desc);
create index if not exists xbox_events_alerts_idx       on public.xbox_detection_events (created_at desc) where is_alert;
create index if not exists xbox_cameras_hb_idx          on public.xbox_cameras (last_heartbeat_at desc);

-- ------------------------------------------------------- derived fields + roll-ups
create or replace function public.xbox_event_before_insert()
returns trigger language plpgsql as $$
declare c record;
begin
  if new.created_at is null then new.created_at := now(); end if;
  if new.skeleton is null then new.skeleton := '[]'::jsonb; end if;
  select armed, label, motion_threshold into c from public.xbox_cameras where id = new.camera_id;
  if new.camera_label is null then new.camera_label := c.label; end if;
  new.severity := case
    when new.event_type in ('person','person+motion') then 'person'
    when new.event_type = 'motion' then 'motion'
    when new.event_type = 'presence-gone' then 'clear'
    else 'info' end;
  new.is_alert := new.event_type in ('person','person+motion','motion') and coalesce(c.armed, true);
  return new;
end $$;

drop trigger if exists xbox_event_before_insert on public.xbox_detection_events;
create trigger xbox_event_before_insert
  before insert on public.xbox_detection_events
  for each row execute function public.xbox_event_before_insert();

create or replace function public.xbox_event_after_insert()
returns trigger language plpgsql as $$
begin
  if new.camera_id is not null then
    update public.xbox_cameras
       set last_event_at = new.created_at,
           persons_last  = case when new.event_type in ('presence-gone','info','test') then persons_last else new.person_count end
     where id = new.camera_id;
  end if;
  return new;
end $$;

drop trigger if exists xbox_event_after_insert on public.xbox_detection_events;
create trigger xbox_event_after_insert
  after insert on public.xbox_detection_events
  for each row execute function public.xbox_event_after_insert();

create or replace function public.xbox_touch_updated_at()
returns trigger language plpgsql as $$ begin new.updated_at := now(); return new; end $$;

drop trigger if exists xbox_cameras_touch on public.xbox_cameras;
create trigger xbox_cameras_touch
  before update on public.xbox_cameras
  for each row execute function public.xbox_touch_updated_at();

-- ---------------------------------------------------------------- device RPCs
-- Self-registration (idempotent per label) — returns the node's access token.
create or replace function public.xbox_register_camera(
  p_label text, p_kind text default 'mobile', p_location text default null, p_notes text default null
) returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.xbox_cameras; out_result jsonb;
begin
  select * into c from public.xbox_cameras where label = p_label and archived = false order by created_at asc limit 1;
  if c.id is null then
    insert into public.xbox_cameras (label, kind, location, notes)
      values (p_label, coalesce(nullif(p_kind,''),'mobile'), p_location, p_notes)
      returning * into c;
  end if;
  select jsonb_build_object('id', c.id, 'label', c.label, 'access_token', c.access_token,
         'created', (xmax = 0), 'armed', c.armed, 'sensitivity', c.sensitivity,
         'motion_threshold', c.motion_threshold, 'cooldown_seconds', c.cooldown_seconds,
         'capture_snapshots', c.capture_snapshots, 'max_fps', c.max_fps)
    into out_result;
  return out_result;
end $$;

-- Liveness + telemetry. Also resets persons_last when the node was presumed gone.
create or replace function public.xbox_heartbeat(
  p_camera_id uuid, p_status text default 'online', p_engine text default null,
  p_fps numeric default null, p_persons integer default null
) returns void language sql security definer set search_path = public as $$
  update public.xbox_cameras
     set last_heartbeat_at = now(),
         status = case when p_status in ('online','offline','degraded') then p_status else status end,
         engine = coalesce(nullif(p_engine,''), engine),
         fps_reported = coalesce(p_fps, fps_reported),
         persons_last = case when p_persons is null then persons_last
                             when last_heartbeat_at is null or now() - last_heartbeat_at > interval '25 seconds' then p_persons
                             else persons_last end
   where id = p_camera_id and archived = false;
$$;

create or replace function public.xbox_mark_ack(p_ids bigint[], p_by text default 'control-center')
returns integer language sql security definer set search_path = public as $$
  with u as (
    update public.xbox_detection_events
       set acknowledged_at = now(), acknowledged_by = p_by
     where id = any (coalesce(p_ids, '{}')::bigint[]) and acknowledged_at is null
    returning id)
  select count(*) from u;
$$;

create or replace function public.xbox_purge_events(p_keep_days integer default 14)
returns integer language sql security definer set search_path = public as $$
  delete from public.xbox_detection_events
   where created_at < now() - make_interval(days => greatest(coalesce(p_keep_days,14), 1))
  returning 1;
$$;

create or replace function public.xbox_sweep_stale()
returns integer language sql security definer set search_path = public as $$
  update public.xbox_cameras set status = 'offline'
   where archived = false and status <> 'offline'
     and (last_heartbeat_at is null or last_heartbeat_at < now() - interval '30 seconds')
  returning 1;
$$;

grant execute on function public.xbox_register_camera(text,text,text,text) to anon, authenticated;
grant execute on function public.xbox_heartbeat(uuid,text,text,numeric,integer) to anon, authenticated;
grant execute on function public.xbox_mark_ack(bigint[],text) to anon, authenticated;
grant execute on function public.xbox_purge_events(integer) to anon, authenticated;
grant execute on function public.xbox_sweep_stale() to anon, authenticated;

-- ---------------------------------------------------------------------- security
-- Single-tenant device mode: the publishable key may read the board and insert
-- events for a *known* node; node lifecycle writes go through the definer RPCs.
alter table public.xbox_cameras enable row level security;
alter table public.xbox_detection_events enable row level security;

drop policy if exists "xbox cameras read"      on public.xbox_cameras;
create policy "xbox cameras read"              on public.xbox_cameras for select to anon, authenticated using (archived = false);

drop policy if exists "xbox cameras config update" on public.xbox_cameras;
create policy "xbox cameras config update"     on public.xbox_cameras for update to anon, authenticated
  using (archived = false) with check (archived = false);

drop policy if exists "xbox events read"       on public.xbox_detection_events;
create policy "xbox events read"               on public.xbox_detection_events for select to anon, authenticated using (true);

drop policy if exists "xbox events insert known camera" on public.xbox_detection_events;
create policy "xbox events insert known camera" on public.xbox_detection_events for insert to anon, authenticated
  with check (exists (select 1 from public.xbox_cameras c where c.id = xbox_detection_events.camera_id and c.archived = false));

drop policy if exists "xbox events acknowledge" on public.xbox_detection_events;
create policy "xbox events acknowledge"         on public.xbox_detection_events for update to anon, authenticated
  using (true) with check (true);

-- ------------------------------------------------------------------- realtime
do $$ begin
  alter publication supabase_realtime add table public.xbox_detection_events;
exception when duplicate_object then null;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.xbox_cameras;
exception when duplicate_object then null;
end $$;

-- -------------------------------------------------------------------- storage
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('xbox-snapshots', 'xbox-snapshots', true, 4194304, array['image/jpeg','image/png'])
on conflict (id) do update set public = true;

drop policy if exists "xbox snapshots read" on storage.objects;
create policy "xbox snapshots read" on storage.objects for select to anon, authenticated using (bucket_id = 'xbox-snapshots');

drop policy if exists "xbox snapshots write" on storage.objects;
create policy "xbox snapshots write" on storage.objects for insert to anon, authenticated
  with check (bucket_id = 'xbox-snapshots' and (storage.foldername(name))[1] = 'xbox');

drop policy if exists "xbox snapshots overwrite" on storage.objects;
create policy "xbox snapshots overwrite" on storage.objects for update to anon, authenticated
  using (bucket_id = 'xbox-snapshots' and (storage.foldername(name))[1] = 'xbox');

-- Housekeeping (called by the control center; wire to pg_cron if you have it).
create or replace function public.xbox_housekeeping()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.xbox_sweep_stale();
  perform public.xbox_purge_events(30);
end $$;
