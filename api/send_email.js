// api/send-email.js
// Menggunakan Resend sebagai contoh layanan email
import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);
const EMAIL_FROM_ADDRESS = process.env.EMAIL_FROM_ADDRESS || 'onboarding@resend.dev'; // Default Resend

export async function sendEmail(to, subject, htmlContent) {
  try {
    const { data, error } = await resend.emails.send({
      from: `STORESKULL <${EMAIL_FROM_ADDRESS}>`,
      to: [to],
      subject: subject,
      html: htmlContent,
    });

    if (error) {
      console.error("Error sending email:", error);
      return { success: false, error };
    }

    console.log("Email sent successfully:", data);
    return { success: true, data };
  } catch (err) {
    console.error("Exception in sendEmail:", err);
    return { success: false, error: err.message };
  }
}
