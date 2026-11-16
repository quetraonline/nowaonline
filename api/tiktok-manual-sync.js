const SUPABASE_URL = process.env.SUPABASE_URL || "https://hfmosadynxpwkscvpard.supabase.co";

async function requireAdmin(req, serviceKey) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return false;
  const userResponse = await fetch(SUPABASE_URL + "/auth/v1/user", {
    headers: { apikey: serviceKey, Authorization: "Bearer " + token }
  });
  if (!userResponse.ok) return false;
  const user = await userResponse.json();
  if (!user || !user.id) return false;
  const adminResponse = await fetch(
    SUPABASE_URL + "/rest/v1/nowa_admins?select=user_id&user_id=eq." + encodeURIComponent(user.id) + "&limit=1",
    { headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey } }
  );
  if (!adminResponse.ok) return false;
  const admins = await adminResponse.json();
  return Array.isArray(admins) && admins.length > 0;
}

async function getGuard(serviceKey) {
  const response = await fetch(SUPABASE_URL + "/rest/v1/nowa_tiktok_sync_guard?select=last_started_at&id=eq.global&limit=1", {
    headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
  });
  if (!response.ok) throw new Error("TikTok tarama durumu okunamadı.");
  const rows = await response.json();
  const lastStartedAt = rows[0] && rows[0].last_started_at || null;
  const nextAllowedAt = lastStartedAt ? new Date(new Date(lastStartedAt).getTime() + 30 * 60 * 1000).toISOString() : null;
  return { lastStartedAt, nextAllowedAt, cooldownMinutes: 30 };
}

export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const apifyToken = process.env.APIFY_API_TOKEN;
  const webhookSecret = process.env.APIFY_WEBHOOK_SECRET;
  if (!serviceKey) return res.status(500).json({ error: "Server configuration is incomplete" });

  try {
    if (!await requireAdmin(req, serviceKey)) return res.status(401).json({ error: "Yönetici oturumu doğrulanamadı." });
    if (req.method === "GET") return res.status(200).json(await getGuard(serviceKey));
    if (!apifyToken || !webhookSecret) return res.status(500).json({ error: "TikTok tarama ayarları eksik." });

    const dbResponse = await fetch(SUPABASE_URL + "/rest/v1/nowa_publishers?select=id,name,platform,channel_url,platform_links,is_published&is_published=eq.true", {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
    });
    if (!dbResponse.ok) throw new Error("Yayıncı listesi okunamadı.");
    const publishers = await dbResponse.json();
    const getHandle = p => {
      const links = p.platform_links && typeof p.platform_links === "object" ? p.platform_links : {};
      const url = links.TikTok || links.tiktok || (String(p.platform || "").toLowerCase() === "tiktok" ? p.channel_url : "");
      const match = String(url || "").match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
      return match ? match[1].toLowerCase() : "";
    };
    const handles = [...new Set(publishers.map(getHandle).filter(Boolean))];
    if (!handles.length) return res.status(200).json({ ok: true, message: "Tarama yapılacak TikTok profili bulunamadı.", profileCount: 0 });

    const claimResponse = await fetch(SUPABASE_URL + "/rest/v1/rpc/claim_nowa_tiktok_sync", {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey, "Content-Type": "application/json" },
      body: "{}"
    });
    if (!claimResponse.ok) throw new Error("Tarama kilidi alınamadı.");
    const claimRows = await claimResponse.json();
    const claim = Array.isArray(claimRows) ? claimRows[0] : claimRows;
    if (!claim || !claim.allowed) {
      return res.status(429).json({
        error: "Son taramadan sonra 30 dakika geçmeden yeni tarama başlatılamaz.",
        lastStartedAt: claim && claim.last_started_at || null,
        nextAllowedAt: claim && claim.next_allowed_at || null
      });
    }

    const webhooks = [{
      eventTypes: ["ACTOR.RUN.SUCCEEDED"],
      requestUrl: "https://nowaonline.vercel.app/api/tiktok-webhook",
      headersTemplate: JSON.stringify({ "x-apify-webhook-secret": webhookSecret }),
      payloadTemplate: '{"eventData":{{eventData}},"resource":{{resource}}}'
    }];
    const webhookParam = Buffer.from(JSON.stringify(webhooks)).toString("base64");
    const runUrl = "https://api.apify.com/v2/acts/socialscrapers~tiktok-scraper/runs?token=" +
      encodeURIComponent(apifyToken) + "&maxTotalChargeUsd=0.08&webhooks=" + encodeURIComponent(webhookParam);
    const runResponse = await fetch(runUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profiles: handles,
        maxVideosPerProfile: 5,
        includeProfileInfo: false,
        profileDetailsOnly: false,
        includeComments: false,
        includeReplies: false,
        proxyConfiguration: { useApifyProxy: true, apifyProxyCountry: "US" }
      })
    });
    const runData = await runResponse.json();
    if (!runResponse.ok) throw new Error("Apify taraması başlatılamadı: " + (runData.error && runData.error.message || runResponse.status));
    return res.status(202).json({
      ok: true,
      status: runData.data && runData.data.status,
      runId: runData.data && runData.data.id,
      profileCount: handles.length,
      maxChargeUsd: 0.08,
      lastStartedAt: claim.last_started_at,
      nextAllowedAt: claim.next_allowed_at
    });
  } catch (error) {
    console.error("TikTok manual scan failed:", error);
    return res.status(500).json({ error: error.message || "TikTok taraması başlatılamadı." });
  }
}
