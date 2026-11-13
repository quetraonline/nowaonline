export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  const clientId = process.env.KICK_CLIENT_ID;
  const clientSecret = process.env.KICK_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    return res.status(503).json({
      ok: false,
      error: "KICK_CLIENT_ID veya KICK_CLIENT_SECRET Vercel Production ortamında tanımlı değil."
    });
  }

  try {
    const tokenResponse = await fetch("https://id.kick.com/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret
      })
    });
    const tokenData = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || !tokenData.access_token) {
      console.error("Kick token request failed:", tokenResponse.status, tokenData.error || "no token");
      return res.status(502).json({ ok: false, stage: "token", error: "Kick erişim anahtarı alınamadı.", kickStatus: tokenResponse.status });
    }

    const slug = String(req.query.slug || "").trim().replace(/^@/, "");
    if (!slug) {
      return res.status(200).json({
        ok: true,
        stage: "token",
        message: "Kick API erişimi başarılı. Kanal testi için ?slug=kanaladi ekleyin.",
        tokenExpiresIn: tokenData.expires_in || null
      });
    }
    if (!/^[a-zA-Z0-9_.-]{1,100}$/.test(slug)) {
      return res.status(400).json({ ok: false, error: "Geçersiz Kick kanal adı." });
    }

    const headers = { Authorization: "Bearer " + tokenData.access_token, "Client-Id": clientId };
    const channelUrl = new URL("https://api.kick.com/public/v1/channels");
    channelUrl.searchParams.set("slug", slug);
    const channelResponse = await fetch(channelUrl, { headers });
    const channelData = await channelResponse.json().catch(() => ({}));
    if (!channelResponse.ok) {
      console.error("Kick channels request failed:", channelResponse.status);
      return res.status(502).json({ ok: false, stage: "channel", error: "Kick kanal bilgisi alınamadı.", kickStatus: channelResponse.status });
    }

    const channel = channelData.data?.[0];
    if (!channel) {
      return res.status(404).json({ ok: false, stage: "channel", error: "Kick kanalı bulunamadı.", slug });
    }

    const liveUrl = new URL("https://api.kick.com/public/v1/livestreams");
    liveUrl.searchParams.set("broadcaster_user_id", String(channel.broadcaster_user_id || channel.user_id || ""));
    const liveResponse = await fetch(liveUrl, { headers });
    const liveData = await liveResponse.json().catch(() => ({}));
    if (!liveResponse.ok) {
      console.error("Kick livestream request failed:", liveResponse.status);
      return res.status(502).json({ ok: false, stage: "livestream", error: "Kick canlı yayın bilgisi alınamadı.", kickStatus: liveResponse.status });
    }

    const live = liveData.data?.[0] || null;
    return res.status(200).json({
      ok: true,
      stage: "complete",
      channel: {
        id: channel.broadcaster_user_id || channel.user_id || null,
        slug: channel.slug || slug,
        name: channel.streamer_channel?.username || channel.username || channel.slug || slug,
        profilePicture: channel.streamer_channel?.profile_picture || channel.profile_picture || null,
        followers: channel.followers_count ?? null
      },
      live: live ? {
        isLive: true,
        title: live.stream_title || live.title || "",
        viewerCount: live.viewer_count ?? null,
        startedAt: live.started_at || null,
        category: live.category?.name || null,
        thumbnail: live.thumbnail || null
      } : { isLive: false },
      message: "Kick kanal ve canlı yayın kontrolü başarılı."
    });
  } catch (error) {
    console.error("Kick test error:", error);
    return res.status(500).json({ ok: false, error: "Kick API testi sırasında beklenmeyen hata oluştu." });
  }
}
