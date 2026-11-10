# Railway Live Statistics Worker

This is an isolated worker for Quetra Online World. It does not change the Vercel site or the existing GitHub Actions tracker.

## Current implementation

- Samples Twitch Helix live viewer counts every 15 seconds for active Twitch sessions already maintained by the existing EventSub integration.
- Connects to TikTok LIVE WebSocket clients for published TikTok publishers that already have an active session row.
- Captures TikTok viewer-count and like snapshots when emitted, plus comment, gift, share, and follow events.
- Writes to the new metrics/events/health tables defined in the accompanying Supabase migration.
- Sends a health heartbeat and restarts automatically under Railway's restart policy.

## Railway variables

Required:
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Twitch:
- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`

Optional:
- `SAMPLE_SECONDS=15`
- `LOG_LEVEL=INFO`

Never commit secrets or put the service-role key in browser code.

## Safe rollout order

1. Create a Supabase development branch or take a verified database backup.
2. Apply `supabase/migrations/20261110210000_nowa_stream_live_metrics.sql` to the development branch only.
3. Run this worker against the development database and test one Twitch and one TikTok account.
4. Verify metric cadence, event deduplication, health heartbeats, reconnect behavior, and session lifecycle.
5. Only after acceptance, schedule the production migration and connect Railway to production Supabase.
6. Keep the existing Twitch EventSub and GitHub Actions TikTok tracker enabled during the observation window. Do not run two session-creation systems against production until session ownership and deduplication have been explicitly validated.

## Important limitations / follow-up before production

- Twitch samples are written only for sessions already opened by the existing Twitch EventSub integration.
- TikTok sockets are opened only for TikTok sessions already active in `nowa_stream_sessions`. The existing five-minute tracker currently owns TikTok session start/end detection. A later cutover should move session lifecycle ownership to this worker with an overlap-safe lock/idempotency strategy.
- TikTokLive is unofficial reverse-engineering software. TikTok may change its protocol or rate limits without notice.
- The current worker's TikTok room metrics depend on events emitted by the room and should be validated against live rooms before production.
- The migration is intentionally not applied to production by this branch.
