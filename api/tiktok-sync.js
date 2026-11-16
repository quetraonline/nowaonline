export default async function handler(req, res) {
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (!process.env.CRON_SECRET || req.headers.authorization !== "Bearer " + process.env.CRON_SECRET) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const apifyToken = process.env.APIFY_API_TOKEN;
  const supabaseUrl = process.env.SUPABASE_URL || "https://hfmosadynxpwkscvpard.supabase.co";
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const webhookSecret = process.env.APIFY_WEBHOOK_SECRET;
  if (!apifyToken || !serviceKey || !webhookSecret) return res.status(500).json({ error: "TikTok sync environment is incomplete" });
  try {
    const dbResponse = await fetch(supabaseUrl + "/rest/v1/nowa_publishers?select=id,name,server,platform,platforms,channel_url,platform_links,is_published&is_published=eq.true", {
      headers: { apikey: serviceKey, Authorization: "Bearer " + serviceKey }
    });
    if (!dbResponse.ok) throw new Error("Supabase publisher query failed: " + dbResponse.status);
    const publishers = await dbResponse.json();
    const getHandle = (p) => {
      const links = p.platform_links && typeof p.platform_links === "object" ? p.platform_links : {};
      const url = links.TikTok || links.tiktok || ((String(p.platform || "").toLowerCase() === "tiktok" ? p.channel_url : ""));
      const match = String(url || "").match(/tiktok\.com\/@([a-zA-Z0-9._]+)/i);
      return match ? match[1].toLowerCase() : "";
    };
    const accounts = publishers.map(p => ({ id: p.id, name: p.name, handle: getHandle(p) })).filter(p => p.handle);
    const uniqueHandles = [...new Set(accounts.map(p => p.handle))];
    if (!uniqueHandles.length) return res.status(200).json({ ok: true, message: "No TikTok profiles found", publishers: 0 });
    const webhook = [{
      eventTypes: ["ACTOR.RUN.SUCCEEDED"],
      requestUrl: "https://" + (process.env.VERCEL_PROJECT_PRODUCTION_URL || "nowaonlineworld.com") + "/api/tiktok-webhook",
      headersTemplate: JSON.stringify({ "x-apify-webhook-secret": webhookSecret }),
      payloadTemplate: '{"eventData":{{eventData}},"resource":{{resource}}}'
    }];
    const webhookParam = Buffer.from(JSON.stringify(webhook)).toString("base64");
    const runUrl = "https://api.apify.com/v2/acts/socialscrapers~tiktok-scraper/runs?token=" +
      encodeURIComponent(apifyToken) + "&maxTotalChargeUsd=0.08&webhooks=" + encodeURIComponent(webhookParam);
    const runResponse = await fetch(runUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        profiles: uniqueHandles,
        maxVideosPerProfile: 5,
        includeProfileInfo: false,
        profileDetailsOnly: false,
        includeComments: false,
        includeReplies: false,
        proxyConfiguration: { useApifyProxy: true, apifyProxyCountry: "US" }
      })
    });
    const runData = await runResponse.json();
    if (!runResponse.ok) throw new Error("Apify run could not start: " + (runData.error && runData.error.message || runResponse.status));
    return res.status(202).json({ ok: true, status: runData.data && runData.data.status, runId: runData.data && runData.data.id, profileCount: uniqueHandles.length, maxChargeUsd: 0.08 });
  } catch (error) {
    console.error("TikTok scheduled sync failed:", error);
    return res.status(500).json({ error: error.message || "TikTok sync failed" });
  }
}
