export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, message: "Method not allowed" });
  }

  try {
    const { name, email, subject, message, website } = req.body || {};

    // Quiet honeypot for basic bot filtering.
    if (website) return res.status(200).json({ ok: true });

    const clean = (value, max) => typeof value === "string" ? value.trim().slice(0, max) : "";
    const safeName = clean(name, 100);
    const safeEmail = clean(email, 150);
    const safeSubject = clean(subject, 150);
    const safeMessage = clean(message, 5000);

    if (!safeName || !safeEmail || !safeSubject || !safeMessage) {
      return res.status(400).json({ ok: false, message: "Lütfen tüm alanları doldurun." });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(safeEmail)) {
      return res.status(400).json({ ok: false, message: "Geçerli bir e-posta adresi girin." });
    }
    if (!process.env.RESEND_API_KEY || !process.env.CONTACT_FROM_EMAIL) {
      console.error("Contact form email environment variables are not configured.");
      return res.status(503).json({ ok: false, message: "E-posta gönderimi şu anda yapılandırılmamış." });
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: process.env.CONTACT_FROM_EMAIL,
        to: ["quetraonline@gmail.com"],
        reply_to: safeEmail,
        subject: `[Nowa Online World İletişim] ${safeSubject}`,
        text: `Ad: ${safeName}\nE-posta: ${safeEmail}\nKonu: ${safeSubject}\n\nMesaj:\n${safeMessage}`
      })
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error("Resend send failed:", response.status, detail.slice(0, 500));
      return res.status(502).json({ ok: false, message: "Mesaj gönderilemedi. Lütfen daha sonra tekrar deneyin." });
    }

    return res.status(200).json({ ok: true, message: "Mesajınız başarıyla gönderildi." });
  } catch (error) {
    console.error("Contact form error:", error);
    return res.status(500).json({ ok: false, message: "Bir hata oluştu. Lütfen tekrar deneyin." });
  }
}
