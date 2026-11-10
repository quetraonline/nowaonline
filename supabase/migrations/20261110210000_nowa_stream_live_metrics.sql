-- Quetra Online World: live metrics foundation
-- Apply only after review in a Supabase development branch. Not applied to production.
create table if not exists public.nowa_stream_metrics (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.nowa_stream_sessions(id) on delete cascade,
  publisher_id uuid not null references public.nowa_publishers(id) on delete cascade,
  platform text not null check (platform in ('Twitch','TikTok')),
  sampled_at timestamptz not null default now(),
  viewer_count integer check (viewer_count is null or viewer_count >= 0),
  like_count bigint check (like_count is null or like_count >= 0),
  share_count bigint check (share_count is null or share_count >= 0),
  comment_count bigint check (comment_count is null or comment_count >= 0),
  gift_count bigint check (gift_count is null or gift_count >= 0),
  gift_value bigint check (gift_value is null or gift_value >= 0),
  raw_metrics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists nowa_stream_metrics_session_sampled_idx
  on public.nowa_stream_metrics(session_id, sampled_at desc);
create index if not exists nowa_stream_metrics_publisher_sampled_idx
  on public.nowa_stream_metrics(publisher_id, sampled_at desc);
create index if not exists nowa_stream_metrics_platform_sampled_idx
  on public.nowa_stream_metrics(platform, sampled_at desc);

create table if not exists public.nowa_stream_events (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.nowa_stream_sessions(id) on delete cascade,
  publisher_id uuid not null references public.nowa_publishers(id) on delete cascade,
  platform text not null check (platform in ('Twitch','TikTok')),
  event_type text not null,
  occurred_at timestamptz not null default now(),
  actor_name text,
  event_text text,
  quantity bigint,
  value bigint,
  external_event_id text,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists nowa_stream_events_session_occurred_idx
  on public.nowa_stream_events(session_id, occurred_at desc);
create index if not exists nowa_stream_events_publisher_occurred_idx
  on public.nowa_stream_events(publisher_id, occurred_at desc);
create unique index if not exists nowa_stream_events_external_id_idx
  on public.nowa_stream_events(platform, external_event_id)
  where external_event_id is not null;

create table if not exists public.nowa_tracker_health (
  tracker_name text primary key,
  status text not null default 'starting' check (status in ('starting','healthy','degraded','stopped')),
  last_heartbeat_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  details jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.nowa_stream_metrics enable row level security;
alter table public.nowa_stream_events enable row level security;
alter table public.nowa_tracker_health enable row level security;
-- No public policies: only trusted server-side service-role operations may access these tables.
