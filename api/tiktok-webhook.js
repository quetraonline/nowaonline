function normalizeHandle(item) {
  const candidates = [
    item.authorMeta && (item.authorMeta.uniqueId || item.authorMeta.name),
    item.author && (item.author.uniqueId || item.author.username || item.author.name),
    item.authorUniqueId, item.username, item.profileName, item.uniqueId
  ].filter(Boolean);
  for (const candidate of candidates) {
    const value = String(candidate).replace(/^@/, "").toLowerCase();
    if (/^[a-z0-9._]+$/.test(value)) return value;
  }
  const url = item.webVideoUrl || item.url || item.videoUrl || "";
  const match = String(url).match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
  return match ? match[1].toLowerCase() : "";
}
function videoDate(item) {
  const raw = item.createTime || item.create_time || item.createdAt || item.createTimeISO || item.publishedAt;
  if (!raw) return null;
  if (typeof raw === "number" || /^\d{10,13}$/.test(String(raw))) {
    const n = Number(raw);
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
function first(...values) { return values.find(v => v !== undefined && v !== null && v !== ""); }
function count(...values) { const n = Number(first(...values, 0)); return Number.isFinite(n) ? n : 0; }
export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.APIFY_WEBHOOK_SECRET || req.headers["x-apify-webhook-secret"] !== process.env.APIFY_WEBHOOK_SECRET) {
    return res.status(401).json({ error: "Unauthorized webhook" });
  }
  const token = process.env.APIFY_API_TOKEN;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const supabaseUrl = process.env.SUPABASE_URL || "https://hfmosadynxpwkscvpard.supabase.co";
  const runId = req.body && ((req.body.eventData && req.body.eventData.actorRunId) || (req.body.resource && req.body.resource.id));
  if (!token || !serviceKey || !runId) return res.status(400).json({ error: "Missing run configuration" });
  try {
    const runResponse = await fetch("https://api.apify.com/v2/actor-runs/" + encodeURIComponent(runId) + "?token=" + encodeURIComponent(token));
    const runJson = await runResponse.json();
    if (!runResponse.ok) throw new Error("Could not read Apify run: " + runResponse.status);
    const datasetId = runJson.data && runJson.data.defaultDatasetId;
    if (!datasetId) throw new Error("Apify run has no dataset");
    const dataResponse = await fetch("https://api.apify.com/v2/datasets/" + encodeURIComponent(datasetId) + "/items?clean=true&format=json&limit=1000&token=" + encodeURIComponent(token));
    const items = await dataResponse.json();
    if (!dataResponse.ok || !Array.isArray(items)) throw new Error("Could not read TikTok dataset");
    const publishersResponse = await fetch(supabaseUrl + "/rest/v1/nowa_publishers?select=id,name,platform,channel_url,platform_links,is_published&is_published=eq.true", {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
    });
    if (!publishersResponse.ok) throw new Error("Could not read publishers from Supabase");
    const publishers = await publishersResponse.json();
    const handleFor = p => {
      const links = p.platform_links && typeof p.platform_links === "object" ? p.platform_links : {};
      const url = links.TikTok || links.tiktok || (String(p.platform || "").toLowerCase() === "tiktok" ? p.channel_url : "");
      const m = String(url || "").match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
      return m ? m[1].toLowerCase() : "";
    };
    const byHandle = new Map();
    for (const p of publishers) { const h = handleFor(p); if (h) { if (!byHandle.has(h)) byHandle.set(h, []); byHandle.get(h).push(p); } }
    const grouped = new Map();
    for (const item of items) {
      const handle = normalizeHandle(item);
      if (!handle || !byHandle.has(handle)) continue;
      const url = first(item.webVideoUrl, item.videoUrl, item.url, item.shareUrl);
      if (!url || !String(url).includes("tiktok.com")) continue;
      const meta = item.videoMeta || item.video || {};
      const stats = item.authorStats || item.stats || {};
      const video = {
        id: String(first(item.id, item.videoId, item.aweme_id, url)),
        url: String(url),
        title: String(first(item.text, item.desc, item.description, item.title, "TikTok videosu")).slice(0, 500),
        thumbnail: String(first(meta.coverUrl, meta.cover, item.coverUrl, item.cover, item.thumbnail, item.videoCover, "")),
        publishedAt: videoDate(item),
        viewCount: count(item.playCount, item.play_count, stats.videoCount && item.playCount),
        likeCount: count(item.diggCount, item.likes, item.likeCount, stats.diggCount),
        commentCount: count(item.commentCount, item.comment_count),
        shareCount: count(item.shareCount, item.share_count)
      };
      for (const publisher of byHandle.get(handle)) {
        if (!grouped.has(publisher.id)) grouped.set(publisher.id, []);
        grouped.get(publisher.id).push(video);
      }
    }
    let updated = 0;
    const updates = [];
    for (const [publisherId, videos] of grouped) {
      const unique = [...new Map(videos.sort((a,b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0)).map(v => [v.id, v])).values()].slice(0, 5);
      updates.push({ publisherId, videos: unique });
    }
    for (let i = 0; i < updates.length; i += 8) {
      await Promise.all(updates.slice(i, i + 8).map(async row => {
        const response = await fetch(supabaseUrl + "/rest/v1/nowa_publishers?id=eq." + encodeURIComponent(row.publisherId), {
          method: "PATCH",
          headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json", Prefer: "return=minimal" },
          body: JSON.stringify({ tiktok_recent_videos: row.videos })
        });
        if (!response.ok) throw new Error("Supabase update failed for publisher " + row.publisherId + ": " + response.status);
        updated++;
      }));
    }
    return res.status(200).json({ ok: true, runId, datasetItems: items.length, publishersUpdated: updated });
  } catch (error) {
    console.error("TikTok webhook processing failed:", error);
    return res.status(500).json({ error: error.message || "Webhook processing failed" });
  }
}
