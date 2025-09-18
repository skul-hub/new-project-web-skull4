// api/provision-pterodactyl.js
// Digunakan di server (Vercel Function, Netlify Function, atau Express route)
import { createClient } from '@supabase/supabase-js';
import fetch from 'node-fetch'; // Pastikan node-fetch terinstal jika di Node.js

// Inisialisasi Supabase di server-side
const supabaseUrl = process.env.SUPABASE_URL; // Ambil dari env
const supabaseKey = process.env.SUPABASE_SERVICE_KEY; // Gunakan service_key untuk operasi admin
const supabase = createClient(supabaseUrl, supabaseKey);

// Import fungsi sendEmail dari file terpisah
import { sendEmail } from './send-email'; // Asumsikan send-email.js ada di direktori yang sama

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const { order_id } = req.body;
    if (!order_id) {
      return res.status(400).json({ error: "Order ID is required" });
    }

    const PTERODACTYL_API_KEY = process.env.PTERODACTYL_API_KEY;
    const PTERODACTYL_PANEL_URL = process.env.PTERODACTYL_PANEL_URL;

    if (!PTERODACTYL_API_KEY || !PTERODACTYL_PANEL_URL) {
      console.error("PTERODACTYL_API_KEY or PTERODACTYL_PANEL_URL is not set.");
      return res.status(500).json({ error: "Pterodactyl API credentials not configured." });
    }

    // 1. Ambil detail pesanan dan produk
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
          egg_id,
          nest_id,
          location_id,
          memory,
          cpu,
          disk,
          swap,
          io,
          databases,
          allocations,
          backups,
          startup_script,
          server_name_prefix
        )
      `)
      .eq("id", order_id)
      .single();

    if (orderError || !order) {
      console.error("Error fetching order:", orderError);
      return res.status(404).json({ error: "Order not found." });
    }

    if (order.products.category !== 'panel_pterodactyl') {
      return res.status(400).json({ error: "Product is not a Pterodactyl panel type." });
    }

    if (order.pterodactyl_server_id) {
      return res.status(200).json({ success: true, message: "Server already provisioned for this order." });
    }

    const productConfig = order.products;

    // 2. Dapatkan atau buat pengguna Pterodactyl
    let pterodactylUserId;
    let pterodactylUserEmail = order.contact_email;
    let pterodactylUsername = order.username || order.contact_email.split('@')[0];

    const { data: existingPteroUser, error: fetchPteroUserError } = await fetch(`${PTERODACTYL_PANEL_URL}/api/application/users?search=${pterodactylUserEmail}`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'Application/vnd.pterodactyl.v1+json',
      },
    }).then(res => res.json());

    if (fetchPteroUserError) {
      console.error("Error fetching Pterodactyl user:", fetchPteroUserError);
    }

    if (existingPteroUser && existingPteroUser.data && existingPteroUser.data.length > 0) {
      pterodactylUserId = existingPteroUser.data[0].attributes.id;
      console.log(`Found existing Pterodactyl user: ${pterodactylUserId}`);
    } else {
      const newPteroUserPayload = {
        email: pterodactylUserEmail,
        username: pterodactylUsername,
        first_name: pterodactylUsername,
        last_name: 'User',
        password: Math.random().toString(36).slice(-10),
      };

      const { data: newPteroUser, error: createPteroUserError } = await fetch(`${PTERODACTYL_PANEL_URL}/api/application/users`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
          'Content-Type': 'application/json',
          'Accept': 'Application/vnd.pterodactyl.v1+json',
        },
        body: JSON.stringify(newPteroUserPayload),
      }).then(res => res.json());

      if (createPteroUserError || !newPteroUser || !newPteroUser.attributes) {
        console.error("Error creating Pterodactyl user:", createPteroUserError || newPteroUser);
        return res.status(500).json({ error: "Failed to create Pterodactyl user." });
      }
      pterodactylUserId = newPteroUser.attributes.id;
      console.log(`Created new Pterodactyl user: ${pterodactylUserId}`);
    }

    // 3. Buat server Pterodactyl
    const serverName = `${productConfig.server_name_prefix || 'Server'} - ${order.username || order.contact_email.split('@')[0]} - ${order.id}`;
    const serverPayload = {
      name: serverName,
      user: pterodactylUserId,
      egg: productConfig.egg_id,
      nest: productConfig.nest_id,
      docker_image: "ghcr.io/pterodactyl/yolks:java", // Contoh, sesuaikan dengan egg
      startup: productConfig.startup_script || "java -Xms128M -Xmx{{SERVER_MEMORY}}M -Dterminal.jline=false -Dterminal.ansi=true -jar server.jar",
      limits: {
        memory: productConfig.memory,
        swap: productConfig.swap,
        disk: productConfig.disk,
        io: productConfig.io,
        cpu: productConfig.cpu,
      },
      feature_limits: {
        databases: productConfig.databases,
        allocations: productConfig.allocations,
        backups: productConfig.backups,
      },
      deploy: {
        locations: [productConfig.location_id],
        dedicated_ip: false,
        port_range: [],
      },
      start_on_completion: true,
      external_id: `order-${order.id}`,
    };

    const { data: newServer, error: createServerError } = await fetch(`${PTERODACTYL_PANEL_URL}/api/application/servers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PTERODACTYL_API_KEY}`,
        'Content-Type': 'application/json',
        'Accept': 'Application/vnd.pterodactyl.v1+json',
      },
      body: JSON.stringify(serverPayload),
    }).then(res => res.json());

    if (createServerError || !newServer || !newServer.attributes) {
      console.error("Error creating Pterodactyl server:", createServerError || newServer);
      return res.status(500).json({ error: "Failed to create Pterodactyl server." });
    }

    const pterodactylServerId = newServer.attributes.uuid;
    const pterodactylServerName = newServer.attributes.name;
    const pterodactylServerIP = newServer.attributes.relationships.allocations.data[0].attributes.ip;
    const pterodactylServerPort = newServer.attributes.relationships.allocations.data[0].attributes.port;

    console.log(`Created Pterodactyl server: ${pterodactylServerId}`);

    // 4. Update status pesanan di database dan simpan server ID
    const { error: updateOrderError } = await supabase
      .from("orders")
      .update({
        status: "done",
        pterodactyl_server_id: pterodactylServerId,
      })
      .eq("id", order_id);

    if (updateOrderError) {
      console.error("Error updating order status and server ID:", updateOrderError);
    }

    // 5. Kirim email ke pengguna
    const emailSubject = `Pesanan Anda Selesai: ${productConfig.name} - #${order.id}`;
    const emailHtml = `
      <p>Halo ${order.username || 'Pelanggan'},</p>
      <p>Pesanan Anda untuk produk <b>${productConfig.name}</b> (Order ID: <code>${order.id}</code>) telah selesai diproses.</p>
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

    // 6. Kirim notifikasi Telegram ke admin
    const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
    const CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID;

    if (BOT_TOKEN && CHAT_ID) {
      const caption = `
        ✅ <b>Pesanan Selesai Otomatis</b>

        🆔 Order ID: <code>${order.id}</code>
        👤 User: <b>${order.username || order.contact_email}</b>
        📦 Produk: <b>${productConfig.name}</b>
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
