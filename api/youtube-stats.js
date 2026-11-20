export default async function handler(req, res) {
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) return res.status(500).json({ error: "YouTube API anahtarı sunucuda tanımlı değil." });

    const isVodFeedRequest = String(req.query.vodfeed || "") === "1";
    if (isVodFeedRequest) res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");

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
    let playlistLiveStreams = [];

    // Her kanal için search.list çağrısı yapılmıyor: YouTube bu isteğe 100 kota birimi
    // uyguluyor ve çok sayıda yayıncıda günlük kotayı hızla tüketiyor.
    // Son canlı yayınlar, uploads oynatma listesindeki video ayrıntılarından çıkarılır.
    const currentLiveStreams = [];

    const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
    if (uploadsPlaylistId) {
      // İlk 50 video içinde arşivlenmiş yayın yoksa daha eski yüklemelere ilerle.
      // En fazla 3 sayfa (150 video) kontrol edilir; gereksiz API kotası tüketilmez.
      let pageToken = "";
      let scannedPages = 0;
      const isVodFeed = String(req.query.vodfeed || "") === "1";
      // VOD akışında 15 arşiv kaydı bulunana kadar daha fazla sayfa tara.
      const maxScanPages = isVodFeed ? 3 : (String(req.query.feed || "") === "1" ? 1 : 3);
      const normalizedVideos = [];
      const archivedFound = [];

      while (scannedPages < maxScanPages && (scannedPages === 0 || pageToken)) {
        const playlistParams = new URLSearchParams({
          part: "contentDetails",
          playlistId: uploadsPlaylistId,
          maxResults: "50",
          key: apiKey
        });
        if (pageToken) playlistParams.set("pageToken", pageToken);

        const playlistResponse = await fetch("https://www.googleapis.com/youtube/v3/playlistItems?" + playlistParams);
        const playlistData = await playlistResponse.json();
        if (!playlistResponse.ok) throw new Error(playlistData.error?.message || "Kanal videoları alınamadı.");

        const videoIds = (playlistData.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
        if (videoIds.length) {
          const videosParams = new URLSearchParams({
            part: "snippet,contentDetails,liveStreamingDetails,statistics",
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
              // YouTube yüklenme tarihi; canlı yayının başlama tarihi actualStartTime alanında ayrı tutulur.
              publishedAt: video.snippet?.publishedAt || live?.actualStartTime || "",
              thumbnail,
              url: "https://www.youtube.com/watch?v=" + encodeURIComponent(video.id),
              isLive: video.snippet?.liveBroadcastContent === "live" && !live?.actualEndTime,
              isUpcoming: video.snippet?.liveBroadcastContent === "upcoming",
              isArchivedStream: Boolean(live?.actualStartTime && live?.actualEndTime),
              actualStartTime: live?.actualStartTime || live?.scheduledStartTime || "",
              actualEndTime: live?.actualEndTime || "",
              viewCount: Number(video.statistics?.viewCount || 0)
            };
          }).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

          normalizedVideos.push(...normalized);
          archivedFound.push(...normalized.filter(video => video.isArchivedStream));
        }

        scannedPages++;
        pageToken = playlistData.nextPageToken || "";
        if (isVodFeed && archivedFound.length >= 15) break;
      }

      // Normal video listesi her zaman en yeni yüklemelerden oluşur.
      normalizedVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
      playlistLiveStreams = normalizedVideos.filter(video => video.isLive && !video.actualEndTime);
      latestVideos = normalizedVideos.filter(video => !video.isLive && !video.isArchivedStream).slice(0, String(req.query.feed || "") === "1" ? 15 : 3);
      const streamCutoff = isVodFeed ? 0 : Date.now() - 30 * 24 * 60 * 60 * 1000;
      latestStreams = isVodFeed
        ? normalizedVideos
            .filter(video => !video.isLive && !video.isUpcoming)
            .sort((a, b) => new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0))
            .slice(0, 15)
        : archivedFound
            .filter(stream => new Date(stream.actualStartTime || stream.publishedAt).getTime() >= streamCutoff)
            .sort((a, b) => new Date(b.actualStartTime || b.publishedAt) - new Date(a.actualStartTime || a.publishedAt))
            .slice(0, 150);
    }

    // Devam eden yayını listenin başına al; kalan yeri en yeni tamamlanmış canlı yayınlarla doldur.
    const archivedStreams = latestStreams;
    if (String(req.query.vodfeed || "") === "1") {
      // Mobil ana sayfa akışı: yalnızca tamamlanmış VOD kayıtları, yüklenme tarihine göre.
      latestStreams = archivedStreams
        .sort((a, b) => new Date(b.publishedAt || b.actualStartTime) - new Date(a.publishedAt || a.actualStartTime))
        .slice(0, 15);
    } else {
      const seenStreamIds = new Set();
      latestStreams = [...currentLiveStreams, ...playlistLiveStreams, ...archivedStreams]
        .filter(stream => {
          if (!stream?.id || seenStreamIds.has(stream.id)) return false;
          seenStreamIds.add(stream.id);
          return true;
        })
        .filter(stream => new Date(stream.actualStartTime || stream.publishedAt).getTime() >= Date.now() - 30 * 24 * 60 * 60 * 1000)
        .slice(0, 150);
    }

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