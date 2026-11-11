export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=3600, stale-while-revalidate=86400");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) return res.status(500).json({ error: "YouTube API anahtarı sunucuda tanımlı değil." });

  const rawUrl = String(req.query.url || "").trim();
  if (!rawUrl) return res.status(400).json({ error: "YouTube kanal bağlantısı gerekli." });

  let parsed;
  try { parsed = new URL(rawUrl); } catch { return res.status(400).json({ error: "Geçersiz YouTube bağlantısı." }); }
  if (!/(^|\.)youtube\.com$/i.test(parsed.hostname) && !/^youtu\.be$/i.test(parsed.hostname)) {
    return res.status(400).json({ error: "Yalnızca YouTube kanal bağlantıları desteklenir." });
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const params = new URLSearchParams({ part: "snippet,statistics", key: apiKey });
  if (/^\/channel\/UC[\w-]+$/i.test(path)) {
    params.set("id", path.split("/")[2]);
  } else if (/^\/@[\w.-]+$/.test(path)) {
    params.set("forHandle", path.slice(2));
  } else if (/^\/user\/[\w.-]+$/i.test(path)) {
    params.set("forUsername", path.split("/")[2]);
  } else {
    const slug = path.split("/").filter(Boolean).pop();
    if (!slug) return res.status(400).json({ error: "Kanal adı bağlantıdan okunamadı." });
    const searchParams = new URLSearchParams({ part: "snippet", type: "channel", q: slug, maxResults: "1", key: apiKey });
    const searchResponse = await fetch("https://www.googleapis.com/youtube/v3/search?" + searchParams);
    const searchData = await searchResponse.json();
    if (!searchResponse.ok) return res.status(searchResponse.status).json({ error: searchData.error?.message || "YouTube kanal araması başarısız." });
    const channelId = searchData.items?.[0]?.id?.channelId;
    if (!channelId) return res.status(404).json({ error: "YouTube kanalı bulunamadı." });
    params.set("id", channelId);
  }

  const response = await fetch("https://www.googleapis.com/youtube/v3/channels?" + params);
  const data = await response.json();
  if (!response.ok) return res.status(response.status).json({ error: data.error?.message || "YouTube istatistikleri alınamadı." });

  const channel = data.items?.[0];
  if (!channel) return res.status(404).json({ error: "YouTube kanalı bulunamadı veya kanal istatistikleri herkese açık değil." });

  const stats = channel.statistics || {};
  return res.status(200).json({
    channelId: channel.id,
    title: channel.snippet?.title || "",
    thumbnail: channel.snippet?.thumbnails?.default?.url || "",
    subscribers: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount || 0),
    views: Number(stats.viewCount || 0),
    videos: Number(stats.videoCount || 0),
    hiddenSubscriberCount: Boolean(stats.hiddenSubscriberCount)
  });
}