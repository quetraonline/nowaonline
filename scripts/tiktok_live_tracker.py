import asyncio
import os
import re
from datetime import datetime, timezone
from urllib.parse import quote

import requests
from TikTokLive import TikTokLiveClient

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
HEADERS = {
    "apikey": SERVICE_KEY,
    "Authorization": f"Bearer {SERVICE_KEY}",
    "Content-Type": "application/json",
}
TIMEOUT = 22

def api(method, path, **kwargs):
    response = requests.request(
        method, f"{SUPABASE_URL}/rest/v1/{path}",
        headers=HEADERS, timeout=25, **kwargs
    )
    response.raise_for_status()
    if response.text:
        return response.json()
    return None

def tiktok_username(publisher):
    links = publisher.get("platform_links") or {}
    url = links.get("TikTok") or ""
    if not url and (publisher.get("platform") or "").lower() == "tiktok":
        url = publisher.get("channel_url") or ""
    match = re.search(r"(?:tiktok\.com/@|^@?)([A-Za-z0-9._]+)", url.strip(), re.I)
    return match.group(1).lstrip("@") if match else None

async def check_live(username):
    client = TikTokLiveClient(unique_id=username)
    try:
        return bool(await asyncio.wait_for(client.is_live(), timeout=TIMEOUT))
    except asyncio.TimeoutError:
        raise RuntimeError("TikTok LIVE kontrolü zaman aşımına uğradı")
    finally:
        try:
            if getattr(client, "connected", False):
                await client.disconnect()
        except Exception:
            pass

async def main():
    publishers = api(
        "GET",
        "nowa_publishers?select=id,name,platform,channel_url,platform_links&is_published=eq.true"
    ) or []
    semaphore = asyncio.Semaphore(5)
    counts = {"checked": 0, "live": 0, "started": 0, "ended": 0, "failed": 0}

    async def process(p):
        username = tiktok_username(p)
        if not username:
            return
        async with semaphore:
            try:
                live = await check_live(username)
                counts["checked"] += 1
                now = datetime.now(timezone.utc)
                now_iso = now.isoformat()
                filters = (
                    "nowa_stream_sessions?select=id,started_at"
                    f"&publisher_id=eq.{quote(p['id'])}"
                    "&platform=eq.TikTok&ended_at=is.null&order=started_at.desc&limit=1"
                )
                open_rows = api("GET", filters) or []
                if live:
                    counts["live"] += 1
                    if not open_rows:
                        api(
                            "POST", "nowa_stream_sessions",
                            json=[{
                                "publisher_id": p["id"],
                                "platform": "TikTok",
                                "stream_title": f"@{username} TikTok canlı yayını",
                                "started_at": now_iso,
                            }],
                            headers={**HEADERS, "Prefer": "return=minimal"},
                        )
                        counts["started"] += 1
                elif open_rows:
                    row = open_rows[0]
                    started = datetime.fromisoformat(row["started_at"].replace("Z", "+00:00"))
                    duration = max(0, int((now - started).total_seconds()))
                    api(
                        "PATCH",
                        f"nowa_stream_sessions?id=eq.{quote(row['id'])}",
                        json={"ended_at": now_iso, "duration_seconds": duration, "updated_at": now_iso},
                        headers={**HEADERS, "Prefer": "return=minimal"},
                    )
                    counts["ended"] += 1
            except Exception as exc:
                counts["failed"] += 1
                print(f"ERROR @{username} ({p.get('name')}): {exc}")

    await asyncio.gather(*(process(p) for p in publishers))
    print("TikTok LIVE tracker:", counts)
    if counts["failed"] and not counts["checked"]:
        raise SystemExit("Hiçbir yayıncı kontrol edilemedi; Supabase/TikTok erişimini kontrol edin.")

if __name__ == "__main__":
    asyncio.run(main())
