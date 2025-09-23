// api/notify.js
// Endpoint API untuk mengirim notifikasi ke Telegram admin.
// Digunakan di server (Vercel Function, Netlify Function, atau Express route).
import { createClient } from '@supabase/supabase-js';

// Inisialisasi Supabase di server-side.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Gunakan service_key untuk operasi admin
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Handler untuk endpoint notifikasi Telegram.
 * Menerima daftar pesanan dan mengirim notifikasi sesuai status pesanan.
 * @param {object} req - Objek request HTTP.
 * @param {object} res - Objek response HTTP.
 */
export default async function handler(req, res) {
  // Hanya menerima request POST.
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { orders } = req.body;
    // Validasi payload.
    if (!orders || !Array.isArray(orders)) {
      return res.status(400).json({ error: "Invalid payload: 'orders' array is required." });
    }

    // Ambil token bot dan chat ID dari environment variables.
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

    // Periksa apakah kredensial Telegram sudah diatur.
    if (!BOT_TOKEN || !CHAT_ID) {
      console.error("TELEGRAM_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID is not set.");
      return res.status(500).json({ error: "Telegram bot credentials not configured." });
    }

    // Ambil URL Pterodactyl Panel dari tabel settings sekali saja.
    const { data: settingsData, error: settingsError } = await supabase.from("settings").select("pterodactyl_panel_url").single();
    const globalPterodactylPanelUrl = settingsData?.pterodactyl_panel_url || "-";

    // Log error jika gagal mengambil URL panel, kecuali jika memang tidak ada baris (PGRST116).
    if (settingsError && settingsError.code !== 'PGRST116') {
      console.error("Error fetching Pterodactyl Panel URL from settings:", settingsError);
    }

    // Iterasi setiap pesanan untuk mengirim notifikasi.
    for (const o of orders) {
      // Fungsi helper untuk escape HTML agar aman dari XSS di Telegram.
      const escapeHtml = (text) => {
        if (!text) return "";
        return text
          .toString()
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;")
          .replace(/'/g, "&#039;");
      };

      // Escape semua data pesanan.
      const orderId = escapeHtml(o.id);
      const username = escapeHtml(o.username);
      const productName = escapeHtml(o.product_name);
      const paymentMethod = escapeHtml(o.payment_method);
      const contactEmail = escapeHtml(o.contact_email || "-");
      const status = escapeHtml(o.status.replace(/_/g, " ").toUpperCase());
      const pterodactylServerId = escapeHtml(o.pterodactyl_server_id || "-");
      const pterodactylPanelUrl = escapeHtml(globalPterodactylPanelUrl); // Gunakan URL panel global

      let caption = "";

      // Buat caption notifikasi berdasarkan status pesanan.
      if (o.status === "waiting_confirmation") {
        caption = `
🛒 <b>Pesanan Baru</b>

🆔 Order ID: <code>${orderId}</code>
👤 User: <b>${username}</b>
📦 Produk: <b>${productName}</b>
📧 Email: <b>${contactEmail}</b>
💳 Metode: <b>${paymentMethod}</b>
📄 Status: <b>Pending Konfirmasi</b>
        `;
      } else if (o.status === "done" && o.product_category === "panel_pterodactyl") {
        caption = `
✅ <b>Pesanan Selesai (Pterodactyl)</b>

🆔 Order ID: <code>${orderId}</code>
👤 User: <b>${username}</b>
📦 Produk: <b>${productName}</b>
📧 Email: <b>${contactEmail}</b>
📄 Status: <b>${status}</b>
⚙️ Server Pterodactyl ID: <code>${pterodactylServerId}</code>
🔗 Panel URL: ${pterodactylPanelUrl}
        `;
      } else {
        caption = `
📢 <b>Update Pesanan</b>

🆔 Order ID: <code>${orderId}</code>
👤 User: <b>${username}</b>
📦 Produk: <b>${productName}</b>
📧 Email: <b>${contactEmail}</b>
📄 Status: <b>${status}</b>
        `;
      }

      let response;
      // Jika ada bukti pembayaran, kirim sebagai foto.
      if (o.payment_proof) {
        response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            photo: o.payment_proof,
            caption: caption,
            parse_mode: "HTML",
          }),
        });
      } else {
        // Jika tidak ada bukti pembayaran, kirim sebagai pesan teks.
        response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: CHAT_ID,
            text: caption,
            parse_mode: "HTML",
          }),
        });
      }

      const result = await response.json();
      // Log error jika Telegram API gagal.
      if (!result.ok) {
        console.error("Telegram API error:", result);
      }
    }

    return res.status(200).json({ success: true, message: "Notifications sent." });
  } catch (err) {
    console.error("Error in notify API:", err);
    return res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
}
