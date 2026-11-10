# TikTok LIVE Tracker

The scheduled GitHub Actions workflow checks public TikTok LIVE status every five minutes and records sessions in Supabase.

## One-time setup

1. Open the GitHub repository: https://github.com/quetraonline/nowaonline
2. Go to **Settings → Secrets and variables → Actions**.
3. Select **New repository secret**.
4. Set the name to `SUPABASE_SERVICE_ROLE_KEY`.
5. Paste the project's Supabase **service_role** key as the value and save it. Never put this key in source code, site JavaScript, or a public issue.
6. Open **Actions → TikTok LIVE Tracker → Run workflow** once to test it.

The Supabase URL is already configured in the workflow. The service-role key is required because the worker writes session rows to the database.

## What it records

- Reads published publishers with a TikTok profile URL from `platform_links.TikTok` (or `channel_url` for TikTok-only publishers).
- Checks whether each public profile is LIVE.
- Opens a TikTok session row when a LIVE is first observed.
- Closes the open row and calculates duration when the account is observed offline.
- The site shows the current status, this month's observed LIVE time, and the latest five tracked sessions.

## Limitations

TikTok does not provide a public official LIVE-history API. This uses the open-source, unofficial TikTokLive client. It checks at roughly five-minute intervals, so short streams can be missed and start/end times can be off by several minutes. It cannot backfill historical sessions from before tracking began. TikTok may change its private Webcast protocol or restrict requests.
