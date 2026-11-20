alter table public.nowa_site_settings
  add column if not exists logo_flag_visible boolean not null default true;
