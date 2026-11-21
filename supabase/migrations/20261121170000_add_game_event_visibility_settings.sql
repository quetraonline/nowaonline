alter table public.nowa_site_settings
  add column if not exists weekly_events_visible boolean not null default true,
  add column if not exists special_events_visible boolean not null default true;
