// api/send-email.js
// Menggunakan Resend sebagai contoh layanan email untuk mengirim email transaksional.
import { Resend } from 'resend';

// Inisialisasi klien Resend dengan API Key dari environment variable.
const resend = new Resend(process.env.RESEND_API_KEY);

// Alamat email pengirim default, bisa di-override oleh environment variable.
const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'onboarding@resend.dev'; // Default Resend

/**
 * Mengirim email ke penerima tertentu dengan subjek dan konten HTML.
 * @param {string} to - Alamat email penerima.
 * @param {string} subject - Subjek email.
 * @param {string} htmlContent - Konten email dalam format HTML.
 * @returns {Promise<{success: boolean, data?: any, error?: any}>} Objek yang menunjukkan keberhasilan pengiriman dan data/error.
 */
export async function sendEmail(to, subject, htmlContent) {
  try {
    // Mengirim email menggunakan Resend API.
    const { data, error } = await resend.emails.send({
      from: `STORESKULL <${EMAIL_FROM_ADDRESS}>`, // Format pengirim: "Nama Pengirim <email@domain.com>"
      to: [to],                                  // Penerima (dalam bentuk array)
      subject: subject,                          // Subjek email
      html: htmlContent,                         // Konten HTML email
    });

    // Menangani error jika ada dari Resend API.
    if (error) {
      console.error("Error sending email:", error);
      return { success: false, error };
    }

    // Log keberhasilan pengiriman email.
    console.log("Email sent successfully:", data);
    return { success: true, data };
  } catch (err) {
    // Menangani exception yang terjadi selama proses pengiriman email.
    console.error("Exception in sendEmail:", err);
    return { success: false, error: err.message };
  }
}
