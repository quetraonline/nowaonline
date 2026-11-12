export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
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
    const params = new URLSearchParams({ part: "snippet,statistics,contentDetails", key: apiKey });
    if (/^\/channel\/UC[\w-]+$/i.test(path)) {
      params.set("id", path.split("/")[2]);
    } else if (/^\/@[\w.-]+$/.test(path)) {
      params.set("forHandle", path.slice(2));
    } else if (/^\/user\/[\w.-]+$/.test(path)) {
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

    let latestVideos = [];
    let latestStreams = [];

    // Aktif canlı yayınları ayrı ara ve videos.list ile gerçekten hâlâ canlı olduklarını doğrula.
    let currentLiveStreams = [];
    try {
      const liveSearchParams = new URLSearchParams({
        part: "snippet",
        channelId: channel.id,
        type: "video",
        eventType: "live",
        maxResults: "5",
        key: apiKey
      });
      const liveSearchResponse = await fetch("https://www.googleapis.com/youtube/v3/search?" + liveSearchParams);
      const liveSearchData = await liveSearchResponse.json();
      if (!liveSearchResponse.ok) {
        console.warn("YouTube canlı yayın araması başarısız:", liveSearchData.error?.message);
      } else {
        const liveIds = (liveSearchData.items || []).map(item => item.id?.videoId).filter(Boolean);
        if (liveIds.length) {
          const verifyParams = new URLSearchParams({
            part: "snippet,liveStreamingDetails",
            id: liveIds.join(","),
            key: apiKey
          });
          const verifyResponse = await fetch("https://www.googleapis.com/youtube/v3/videos?" + verifyParams);
          const verifyData = await verifyResponse.json();
          if (!verifyResponse.ok) {
            console.warn("YouTube canlı yayın doğrulaması başarısız:", verifyData.error?.message);
          } else {
            currentLiveStreams = (verifyData.items || [])
              .filter(video => video.snippet?.liveBroadcastContent === "live" && video.liveStreamingDetails?.actualEndTime == null)
              .map(video => {
                const thumbs = video.snippet?.thumbnails || {};
                return {
                  id: video.id,
                  title: video.snippet?.title || "Canlı yayın",
                  publishedAt: video.liveStreamingDetails?.actualStartTime || video.snippet?.publishedAt || "",
                  thumbnail: thumbs.maxres?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || "",
                  url: "https://www.youtube.com/watch?v=" + encodeURIComponent(video.id),
                  isLive: true,
                  actualStartTime: video.liveStreamingDetails?.actualStartTime || ""
                };
              });
          }
        }
      }
    } catch (liveSearchError) {
      console.warn("YouTube canlı yayın doğrulaması yapılamadı:", liveSearchError);
    }
    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (uploadsPlaylistId) {
      const playlistParams = new URLSearchParams({
        part: "contentDetails",
        playlistId: uploadsPlaylistId,
        maxResults: "50",
        key: apiKey
      });
      const playlistResponse = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?" + playlistParams);
      const playlistData = await playlistResponse.json();
      if (!playlistResponse.ok) throw new Error(playlistData.error?.message || "Kanal videoları alınamadı.");

      const videoIds = (playlistData.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
      if (videoIds.length) {
        const videosParams = new URLSearchParams({
          part: "snippet,contentDetails,liveStreamingDetails",
          id: videoIds.join(","),
          key: apiKey
        });
        const videosResponse = await fetch("https://www.googleapis.com/youtube/v3/videos?" + videosParams);
        const videosData = await videosResponse.json();
        if (!videosResponse.ok) throw new Error(videosData.error?.message || "Video ayrıntıları alınamadı.");

        const normalized = (videosData.items || []).map(video => {
          const thumbs = video.snippet?.thumbnails || {};
          const thumbnail = thumbs.maxres?.url || thumbs.standard?.url || thumbs.high?.url || thumbs.medium?.url || thumbs.default?.url || "";
          const live = video.liveStreamingDetails || null;
          return {
            id: video.id,
            title: video.snippet?.title || "Başlıksız içerik",
            publishedAt: video.snippet?.publishedAt || "",
            thumbnail,
            url: "https://www.youtube.com/watch?v=" + encodeURIComponent(video.id),
            // Bu liste uploads arşivinden gelir; geçmiş yayınlar canlı etiketi almamalı.
            isLive: false,
            actualStartTime: live?.actualStartTime || live?.scheduledStartTime || ""
          };
        }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

        latestVideos = normalized.filter(video => !video.isLive).slice(0, 2);
        latestStreams = normalized.filter(video => video.isLive && video.actualStartTime).slice(0, 2);
      }
    }

    // Aktif yayınları listenin başına al; kalan yeri en yeni arşivlenmiş canlı yayınlarla tamamla.
    const archivedStreams = latestStreams;
    const seenStreamIds = new Set();
    latestStreams = [...currentLiveStreams, ...archivedStreams]
      .filter(stream => {
        if (!stream?.id || seenStreamIds.has(stream.id)) return false;
        seenStreamIds.add(stream.id);
        return true;
      })
      .slice(0, 2);

    const stats = channel.statistics || {};
    return res.status(200).json({
      channelId: channel.id,
      title: channel.snippet?.title || "",
      thumbnail: channel.snippet?.thumbnails?.default?.url || "",
      subscribers: stats.hiddenSubscriberCount ? null : Number(stats.subscriberCount || 0),
      views: Number(stats.viewCount || 0),
      videos: Number(stats.videoCount || 0),
      hiddenSubscriberCount: Boolean(stats.hiddenSubscriberCount),
      latestVideos,
      latestStreams
    });
  } catch (error) {
    return res.status(502).json({ error: error.message || "YouTube verileri alınırken bir hata oluştu." });
  }
}