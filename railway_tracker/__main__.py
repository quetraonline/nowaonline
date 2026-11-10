import asyncio
import json
import logging
import os
import re
import signal
from datetime import datetime, timezone
from typing import Any

import httpx
from TikTokLive import TikTokLiveClient
from TikTokLive.events import CommentEvent, GiftEvent, LikeEvent, RoomUserSeqEvent, ShareEvent, FollowEvent

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("nowa-railway-tracker")

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
TWITCH_CLIENT_ID = os.getenv("TWITCH_CLIENT_ID", "")
TWITCH_CLIENT_SECRET = os.getenv("TWITCH_CLIENT_SECRET", "")
SAMPLE_SECONDS = max(15, int(os.getenv("SAMPLE_SECONDS", "15")))
HEARTBEAT_SECONDS = 30
HTTP_TIMEOUT = 15.0

def utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()

def username_from_url(value: str | None, platform: str) -> str | None:
    if not value:
        return None
    value = str(value).strip()
    if platform == "Twitch":
        m = re.search(r"(?:https?://)?(?:www\.)?twitch\.tv/([A-Za-z0-9_]+)", value, re.I)
        return m.group(1).lower() if m else None
    m = re.search(r"(?:https?://)?(?:www\.)?tiktok\.com/@([^/?#]+)", value, re.I)
    if m:
        return m.group(1)
    value = value.removeprefix("@")
    return value if re.fullmatch(r"[A-Za-z0-9._]+", value) else None

def json_safe(value: Any) -> Any:
    try:
        json.dumps(value)
        return value
    except Exception:
        return str(value)

class Store:
    def __init__(self):
        self.client = httpx.AsyncClient(
            base_url=f"{SUPABASE_URL}/rest/v1/",
            headers={"apikey": SERVICE_KEY, "Authorization": f"Bearer {SERVICE_KEY}",
                     "Content-Type": "application/json", "Prefer": "return=representation"},
            timeout=HTTP_TIMEOUT,
        )

    async def get(self, path: str):
        r = await self.client.get(path); r.raise_for_status(); return r.json()

    async def post(self, path: str, payload: dict | list, *, minimal: bool = False):
        headers={"Prefer": "return=minimal" if minimal else "return=representation"}
        r=await self.client.post(path, json=payload, headers=headers); r.raise_for_status()
        return r.json() if r.text else None

    async def patch(self, path: str, payload: dict):
        r=await self.client.patch(path, json=payload, headers={"Prefer":"return=minimal"}); r.raise_for_status()

    async def publishers(self):
        return await self.get("nowa_publishers?select=id,name,platform,channel_url,platform_links,is_published&is_published=eq.true")

    async def active_sessions(self):
        rows=await self.get("nowa_stream_sessions?select=id,publisher_id,platform,started_at&ended_at=is.null")
        return {(x["publisher_id"], x["platform"]): x for x in rows}

    async def metric(self, session: dict, values: dict):
        await self.post("nowa_stream_metrics", {
            "session_id": session["id"], "publisher_id": session["publisher_id"],
            "platform": session["platform"], "sampled_at": utcnow(),
            "viewer_count": values.get("viewer_count"),
            "like_count": values.get("like_count"),
            "share_count": values.get("share_count"),
            "comment_count": values.get("comment_count"),
            "gift_count": values.get("gift_count"),
            "gift_value": values.get("gift_value"),
            "raw_metrics": values.get("raw_metrics", {}),
        }, minimal=True)

    async def event(self, session: dict, event_type: str, **kwargs):
        payload = {"session_id":session["id"],"publisher_id":session["publisher_id"],
                   "platform":session["platform"],"event_type":event_type,
                   "occurred_at":utcnow(), **kwargs}
        await self.post("nowa_stream_events", payload, minimal=True)

    async def health(self, status="healthy", error=None, details=None):
        payload={
            "tracker_name":"railway-live-tracker","status":status,
            "last_heartbeat_at":utcnow(),
            "last_error":str(error)[:1000] if error else None,"details":details or {},"updated_at":utcnow()
        }
        if status == "healthy":
            payload["last_success_at"] = utcnow()
        r=await self.client.post("nowa_tracker_health?on_conflict=tracker_name",json=payload,
            headers={"Prefer":"resolution=merge-duplicates,return=minimal"})
        r.raise_for_status()

    async def close(self):
        await self.client.aclose()

class TwitchSampler:
    def __init__(self, store: Store):
        self.store=store
        self.token=None
        self.token_expiry=0

    async def app_token(self, http):
        import time
        if self.token and time.time() < self.token_expiry-60:
            return self.token
        r=await http.post("https://id.twitch.tv/oauth2/token", data={
            "client_id":TWITCH_CLIENT_ID,"client_secret":TWITCH_CLIENT_SECRET,
            "grant_type":"client_credentials"})
        r.raise_for_status(); data=r.json()
        self.token=data["access_token"]; self.token_expiry=time.time()+int(data.get("expires_in",3600))
        return self.token

    async def sample(self, publishers, sessions):
        if not TWITCH_CLIENT_ID or not TWITCH_CLIENT_SECRET:
            return
        profiles={}
        for p in publishers:
            links=p.get("platform_links") or {}
            url=links.get("Twitch") or (p.get("channel_url") if p.get("platform")=="Twitch" else None)
            login=username_from_url(url,"Twitch")
            if login: profiles[login]=p
        if not profiles: return
        async with httpx.AsyncClient(timeout=HTTP_TIMEOUT) as http:
            token=await self.app_token(http)
            headers={"Client-ID":TWITCH_CLIENT_ID,"Authorization":f"Bearer {token}"}
            logins=list(profiles)
            for start in range(0,len(logins),100):
                params=[("user_login",x) for x in logins[start:start+100]]
                r=await http.get("https://api.twitch.tv/helix/streams",headers=headers,params=params)
                r.raise_for_status()
                for stream in r.json().get("data",[]):
                    p=profiles.get(stream.get("user_login","").lower())
                    if not p: continue
                    session=sessions.get((p["id"],"Twitch"))
                    if not session: continue
                    await self.store.metric(session, {
                        "viewer_count":int(stream.get("viewer_count",0)),
                        "raw_metrics":{"title":stream.get("title"),"game_name":stream.get("game_name"),
                                       "started_at":stream.get("started_at"),"language":stream.get("language")}
                    })

class TikTokManager:
    def __init__(self, store: Store):
        self.store=store
        self.clients={}
        self.last_metrics={}
        self.sessions={}

    async def sync(self, publishers, sessions):
        wanted={}
        for p in publishers:
            links=p.get("platform_links") or {}
            url=links.get("TikTok") or (p.get("channel_url") if p.get("platform")=="TikTok" else None)
            username=username_from_url(url,"TikTok")
            if username and (p["id"],"TikTok") in sessions:
                wanted[p["id"]]=(username,p,sessions[(p["id"],"TikTok")])
        for publisher_id in list(self.clients):
            if publisher_id not in wanted:
                client,task=self.clients.pop(publisher_id)
                if client.connected: await client.disconnect()
                task.cancel()
        for publisher_id,(username,p,session) in wanted.items():
            previous = self.sessions.get(publisher_id)
            if previous and previous.get("id") != session.get("id"):
                self.last_metrics.pop(publisher_id, None)
            self.sessions[publisher_id]=session
            if publisher_id not in self.clients:
                client=TikTokLiveClient(unique_id=username)
                self._register(client,publisher_id,session)
                task=asyncio.create_task(client.connect(fetch_room_info=True,fetch_gift_info=True))
                self.clients[publisher_id]=(client,task)
                log.info("TikTok LIVE socket starting: @%s",username)
        for publisher_id,(client,task) in list(self.clients.items()):
            if task.done():
                err=task.exception() if not task.cancelled() else None
                log.warning("TikTok socket ended for %s: %s",publisher_id,err)
                self.clients.pop(publisher_id,None)

    def _register(self, client, publisher_id, session):
        @client.on(RoomUserSeqEvent)
        async def room_users(event):
            count=getattr(event,"total",None)
            if count is None: count=getattr(event,"viewer_count",None)
            if count is None: count=getattr(event,"total_user",None)
            if count is not None:
                self.last_metrics.setdefault(publisher_id,{})["viewer_count"]=int(count)

        @client.on(LikeEvent)
        async def likes(event):
            values=self.last_metrics.setdefault(publisher_id,{})
            values["like_count"]=int(getattr(event,"total",0) or 0)

        @client.on(CommentEvent)
        async def comments(event):
            user=getattr(getattr(event,"user",None),"unique_id",None)
            values=self.last_metrics.setdefault(publisher_id,{})
            values["comment_count"]=int(values.get("comment_count",0))+1
            await self.store.event(session,"comment",actor_name=user,event_text=str(getattr(event,"comment",""))[:1000])

        @client.on(GiftEvent)
        async def gifts(event):
            gift=getattr(event,"gift",None)
            if gift is None: return
            if getattr(event,"streaking",False) and getattr(gift,"type",None)==1: return
            quantity=int(getattr(event,"repeat_count",1) or 1)
            diamonds=int(getattr(gift,"diamond_count",0) or 0)*quantity
            values=self.last_metrics.setdefault(publisher_id,{})
            values["gift_count"]=int(values.get("gift_count",0))+quantity
            values["gift_value"]=int(values.get("gift_value",0))+diamonds
            await self.store.event(session,"gift",actor_name=getattr(getattr(event,"user",None),"unique_id",None),
                event_text=str(getattr(gift,"name","Gift")),quantity=quantity,value=diamonds,
                payload={"diamond_count":getattr(gift,"diamond_count",None)})

        @client.on(ShareEvent)
        async def shares(event):
            values=self.last_metrics.setdefault(publisher_id,{})
            values["share_count"]=int(values.get("share_count",0))+1
            await self.store.event(session,"share",actor_name=getattr(getattr(event,"user",None),"unique_id",None))

        @client.on(FollowEvent)
        async def follows(event):
            await self.store.event(session,"follow",actor_name=getattr(getattr(event,"user",None),"unique_id",None))

    async def flush(self, sessions):
        for publisher_id,values in list(self.last_metrics.items()):
            session=sessions.get((publisher_id,"TikTok"))
            if session and values:
                await self.store.metric(session,values.copy())

    async def close(self):
        for client,task in self.clients.values():
            if client.connected: await client.disconnect()
            if not task.done(): task.cancel()

async def run():
    store=Store()
    twitch=TwitchSampler(store)
    tiktok=TikTokManager(store)
    stop=asyncio.Event()
    loop=asyncio.get_running_loop()
    for sig in (signal.SIGINT,signal.SIGTERM):
        try: loop.add_signal_handler(sig,stop.set)
        except NotImplementedError: pass
    log.info("Quetra live tracker starting; sample interval=%ss",SAMPLE_SECONDS)
    try:
        while not stop.is_set():
            started=datetime.now(timezone.utc)
            try:
                publishers=await store.publishers()
                sessions=await store.active_sessions()
                await tiktok.sync(publishers,sessions)
                await twitch.sample(publishers,sessions)
                await tiktok.flush(sessions)
                await store.health("healthy",details={"publishers":len(publishers),"active_sessions":len(sessions),"sample_seconds":SAMPLE_SECONDS})
            except Exception as exc:
                log.exception("Tracker cycle failed")
                try: await store.health("degraded",error=exc)
                except Exception: log.exception("Could not write tracker health")
            elapsed=(datetime.now(timezone.utc)-started).total_seconds()
            try: await asyncio.wait_for(stop.wait(),timeout=max(1,SAMPLE_SECONDS-elapsed))
            except asyncio.TimeoutError: pass
    finally:
        await tiktok.close()
        await store.close()
        log.info("Tracker stopped")

if __name__=="__main__":
    asyncio.run(run())
