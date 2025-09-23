// api/provision-pterodactyl.js
// Endpoint API untuk memprovision server Pterodactyl secara otomatis.
// Digunakan di server (Vercel Function, Netlify Function, atau Express route).
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch'; // Pastikan node-fetch terinstal jika di Node.js (untuk lingkungan Node.js murni)

// Import fungsi sendEmail dari file terpisah.
import { sendEmail } from './send_email'; // Pastikan path ini benar

// Inisialisasi Supabase di server-side.
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Gunakan service_key untuk operasi admin
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Handler untuk endpoint provisioning Pterodactyl.
 * Menerima order_id, membuat user/server di Pterodactyl, update status order, dan kirim notifikasi.
 * @param {object} req - Objek request HTTP.
 * @param {object} res - Objek response HTTP.
 */
export default async function handler(req, res) {
  // Hanya menerima request POST.
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { order_id } = req.body;
    // Validasi order_id.
    if (!order_id) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    // Ambil Pterodactyl API Key dan Panel URL dari tabel settings.
    const { data: settings, error: settingsError } = await supabase
      .from("settings")
      .select("pterodactyl_api_key, pterodactyl_panel_url")
      .single();

    // Periksa apakah kredensial Pterodactyl sudah dikonfigurasi.
    if (settingsError || !settings || !settings.pterodactyl_api_key || !settings.pterodactyl_panel_url) {
      console.error("Pterodactyl API Key or Panel URL is not configured in settings table.");
      return res.status(500).json({ error: "Pterodactyl API credentials not configured by admin." });
    }

    const PTERODACTYL_API_KEY = settings.pterodactyl_api_key;
    const PTERODACTYL_PANEL_URL = settings.pterodactyl_panel_url;

    // 1. Ambil detail pesanan, produk, dan konfigurasi Pterodactyl terkait.
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select(`
        id,
        user_id,
        product_id,
        contact_email,
        username,
        status,
        pterodactyl_server_id,
        products (
          name,
          category,
          pterodactyl_config_id,
          pterodactyl_configs (
            id,             // Tambahkan ID konfigurasi untuk referensi
            name as config_name,
            egg_id,
            nest_id,
            location_id,
            memory,
            cpu,
            disk,
            swap,
            io
          )
        )
      `)
      .eq("id", order_id)
      .single();

    // Tangani error jika pesanan tidak ditemukan atau ada masalah pengambilan data.
    if (orderError || !order) {
      console.error("Error fetching order:", orderError);
      return res.status(404).json({ error: "Order not found." });
    }

    // Pastikan produk adalah tipe Pterodactyl.
    if (order.products.category !== 'panel_pterodactyl') {
      return res.status(400).json({ error: "Product is not a Pterodactyl panel type." });
    }

    // Pastikan konfigurasi Pterodactyl terhubung ke produk.
    if (!order.products.pterodactyl_configs) {
      console.error("Pterodactyl configuration not found for product:", order.products.name);
      return res.status(500).json({ error: "Pterodactyl configuration not linked to product. Please check product settings." });
    }

    // Jika server sudah diprovision, kembalikan sukses.
    if (order.pterodactyl_server_id) {
      return res.status(200).json({ success: true, message: "Server already provisioned for this order." });
    }

    const productConfig = order.products.pterodactyl_configs; // Gunakan konfigurasi yang terhubung

    // 2. Dapatkan atau buat pengguna Pterodactyl.
    let pterodactylUserId;
    let pterodactylUserEmail = order.contact_email;
    let pterodactylUsername = order.username || order.contact_email.split('@')[0];

    // Coba cari pengguna Pterodactyl yang sudah ada berdasarkan email.
    const existingPteroUserResponse = await fetch(`${PTERODACTYL_PANEL_URL}/api/application/users?search=${pterodactylUserEmail}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'Application/vnd.pterodactyl.v1+json',
      },
    });
    const existingPteroUserData = await existingPteroUserResponse.json();

    if (!existingPteroUserResponse.ok) {
      console.error("Error fetching Pterodactyl user:", existingPteroUserData);
      // Lanjutkan, karena mungkin user belum ada, dan kita akan buat baru
    }

    if (existingPteroUserData && existingPteroUserData.data && existingPteroUserData.data.length > 0) {
      pterodactylUserId = existingPteroUserData.data[0].attributes.id;
      console.log(`Found existing Pterodactyl user: ${pterodactylUserId}`);
    } else {
      // Jika user tidak ditemukan, buat user baru di Pterodactyl.
      const newPteroUserPayload = {
        email: pterodactylUserEmail,
        username: pterodactylUsername,
        first_name: pterodactylUsername,
        last_name: 'User', // Default last name
        password: Math.random().toString(36).slice(-10), // Generate password acak
      };

      const newPteroUserResponse = await fetch(`${PTERODACTYL_PANEL_URL}/api/application/users`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'Application/vnd.pterodactyl.v1+json',
        },
        body: JSON.stringify(newPteroUserPayload),
      });
      const newPteroUserData = await newPteroUserResponse.json();

      if (!newPteroUserResponse.ok || !newPteroUserData || !newPteroUserData.attributes) {
        console.error("Error creating Pterodactyl user:", newPteroUserData);
        return res.status(500).json({ error: "Failed to create Pterodactyl user." });
      }
      pterodactylUserId = newPteroUserData.attributes.id;
      console.log(`Created new Pterodactyl user: ${pterodactylUserId}`);
    }

    // 3. Buat server Pterodactyl.
    // Nama server akan dinamis, tidak lagi dari konfigurasi statis.
    const serverName = `Server ${order.products.name} - ${order.username || order.contact_email.split('@')[0]} - ${order.id}`;
    const serverPayload = {
      name: serverName,
      user: pterodactylUserId,
      egg: productConfig.egg_id,
      nest: productConfig.nest_id,
      docker_image: "ghcr.io/pterodactyl/yolks:java", // Default, Pterodactyl akan menggunakan default egg jika tidak ditentukan
      limits: {
        memory: productConfig.memory,
        swap: productConfig.swap,
        disk: productConfig.disk,
        io: productConfig.io,
        cpu: productConfig.cpu,
      },
      deploy: {
        locations: [productConfig.location_id],
        dedicated_ip: false,
        port_range: [], // Biarkan kosong agar Pterodactyl mengalokasikan port secara otomatis
      },
      start_on_completion: true, // Server akan otomatis start setelah dibuat
      external_id: `order-${order.id}`, // ID eksternal untuk melacak pesanan
    };

    const newServerResponse = await fetch(`${PTERODACTYL_PANEL_URL}/api/application/servers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'Application/vnd.pterodactyl.v1+json',
      },
      body: JSON.stringify(serverPayload),
    });
    const newServerData = await newServerResponse.json();

    if (!newServerResponse.ok || !newServerData || !newServerData.attributes) {
      console.error("Error creating Pterodactyl server:", newServerData);
      return res.status(500).json({ error: "Failed to create Pterodactyl server." });
    }

    const pterodactylServerId = newServerData.attributes.uuid;
    const pterodactylServerName = newServerData.attributes.name;
    // Pastikan alokasi ada sebelum mencoba mengaksesnya.
    const allocation = newServerData.attributes.relationships.allocations.data[0]?.attributes;
    const pterodactylServerIP = allocation ? allocation.ip : 'N/A';
    const pterodactylServerPort = allocation ? allocation.port : 'N/A';

    console.log(`Created Pterodactyl server: ${pterodactylServerId}`);

    // 4. Update status pesanan di database dan simpan server ID.
    const { error: updateOrderError } = await supabase
      .from("orders")
      .update({
        status: "done", // Set status pesanan menjadi 'done'
        pterodactyl_server_id: pterodactylServerId, // Simpan ID server Pterodactyl
      })
      .eq("id", order_id);

    if (updateOrderError) {
      console.error("Error updating order status and server ID:", updateOrderError);
      // Lanjutkan eksekusi, karena server sudah dibuat, hanya update DB yang gagal.
      // Admin mungkin perlu memeriksa secara manual.
    }

    // 5. Kirim email ke pengguna dengan detail server.
    const emailSubject = `Pesanan Anda Selesai: ${order.products.name} - #${order.id}`;
    const emailHtml = `
      <p>Halo ${order.username || 'Pelanggan'},</p>
      <p>Pesanan Anda untuk produk <b>${order.products.name}</b> (Order ID: <code>${order.id}</code>) telah selesai diproses.</p>
      <p>Detail akses panel Pterodactyl Anda:</p>
      <ul>
        <li><b>URL Panel:</b> <a href="${PTERODACTYL_PANEL_URL}">${PTERODACTYL_PANEL_URL}</a></li>
        <li><b>Username:</b> ${pterodactylUserEmail}</li>
        <li><b>Password:</b> Jika ini adalah akun baru, Anda akan menerima email terpisah dari Pterodactyl untuk mengatur password. Jika Anda sudah memiliki akun, gunakan password yang sudah ada.</li>
        <li><b>Nama Server:</b> ${pterodactylServerName}</li>
        <li><b>IP Server:</b> <code>${pterodactylServerIP}:${pterodactylServerPort}</code></li>
      </ul>
      <p>Silakan login ke panel Pterodactyl untuk mengelola server Anda.</p>
      <p>Terima kasih telah berbelanja di STORESKULL!</p>
      <p>Hormat kami,<br>Tim STORESKULL</p>
    `;

    await sendEmail(order.contact_email, emailSubject, emailHtml);
    console.log(`Email sent to ${order.contact_email}`);

    // 6. Kirim notifikasi Telegram ke admin.
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

    if (BOT_TOKEN && CHAT_ID) {
      const caption = `
        ✅ <b>Pesanan Selesai Otomatis</b>

        🆔 Order ID: <code>${order.id}</code>
        👤 User: <b>${order.username || order.contact_email}</b>
        📦 Produk: <b>${order.products.name}</b>
        📧 Email: <b>${order.contact_email}</b>
        📄 Status: <b>DONE (Auto-Provisioned)</b>
        ⚙️ Server Pterodactyl ID: <code>${pterodactylServerId}</code>
        🔗 Panel URL: ${PTERODACTYL_PANEL_URL}
      `;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: CHAT_ID,
          text: caption,
          parse_mode: "HTML",
        }),
      });
      console.log("Telegram notification sent for auto-provisioned order.");
    }

    return res.status(200).json({ success: true, message: "Pterodactyl server provisioned and order completed." });

  } catch (err) {
    console.error("Error in provision-pterodactyl API:", err);
    return res.status(500).json({ error: "Internal Server Error", details: err.message });
  }
}
