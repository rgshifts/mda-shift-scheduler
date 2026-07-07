// ============================================================
//  Transactional Email Service — Nodemailer + Brevo SMTP
//  On-demand email endpoint using Nodemailer with Brevo SMTP relay.
//  Handles all 5 required email actions with full Hebrew templates.
//
//  Environment variables:
//    • SMTP_HOST      — Brevo SMTP server (e.g., smtp-relay.brevo.com)
//    • SMTP_PORT      — SMTP port (usually 587)
//    • SMTP_USER      — Login email/username
//    • SMTP_PASS      — Login password
//    • SENDER_NAME    — Display name for sender (e.g., "מערכת שיבוצים רמת גן")
//    • SENDER_EMAIL   — From address (e.g., noreply@example.com)
//
//  The function accepts POST requests with a JSON body specifying:
//    • action         — One of: 'registration', 'passwordReset', 'requestReminder', 'shiftChange', 'schedulePublished'
//    • to             — Recipient email
//    • username       — User's name (for greeting)
//    • actionUrl      — Verification/reset link (when applicable)
//    • scheduleInfo   — Schedule details (for schedule emails)
// ============================================================

import type { Config } from "@netlify/functions";
import nodemailer from "nodemailer";

/* ==================== SMTP Transporter ==================== */
// Initialize once and reuse across requests.
let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      "Missing SMTP configuration: SMTP_HOST, SMTP_USER, and SMTP_PASS are required"
    );
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465, // TLS if port is not 465, SSL if 465
    auth: {
      user,
      pass,
    },
  });

  return transporter;
}

/* ==================== Email Shell & Shared Styles ==================== */
// Shared RTL Hebrew email shell for consistent branding.
function emailShell(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;background:#f3efe6;font-family:'Segoe UI', Arial, Helvetica, sans-serif;color:#211c19;">
  <div style="max-width:520px;margin:24px auto;background:#fffdf8;border:1px solid #e2dac9;border-radius:16px;padding:32px 28px;">
    <h1 style="font-size:22px;margin:0 0 16px;color:#1b3aa0;font-weight:700;">${title}</h1>
    <div style="font-size:14px;line-height:1.7;color:#211c19;">
      ${bodyHtml}
    </div>
    <hr style="border:none;border-top:1px solid #e2dac9;margin:28px 0;" />
    <p style="font-size:11px;color:#908779;margin:0;text-align:center;">
      מערכת שיבוץ משמרות וחניכים — מד״א רמת גן
    </p>
  </div>
</body>
</html>`;
}

// HTML escaper to prevent XSS in interpolated values.
function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ==================== Email Template Functions ==================== */

// 1. Registration/Verification Email
function registrationEmailHtml(username: string, verificationLink: string): string {
  const bodyHtml = `
    <p style="margin:0 0 16px;">שלום ${escapeHtml(username)},</p>
    <p style="margin:0 0 18px;">
      תודה שנרשמת למערכת שיבוץ המשמרות! כדי להשלים את ההרשמה, אנא אמת את כתובת הדוא״ל שלך על ידי לחיצה על הכפתור למטה:
    </p>
    <p style="margin:0 0 20px;text-align:center;">
      <a href="${escapeHtml(verificationLink)}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;transition:background 0.2s;">
        אימות כתובת הדוא״ל
      </a>
    </p>
    <p style="font-size:12px;color:#5c5349;line-height:1.6;margin:0;">
      אם הכפתור אינו עובד, העתיקו את הקישור הבא לדפדפן שלכם:<br />
      <span style="direction:ltr;display:inline-block;word-break:break-all;background:#f5f1ea;padding:8px 10px;border-radius:4px;margin-top:8px;">
        ${escapeHtml(verificationLink)}
      </span>
    </p>
    <p style="font-size:12px;color:#908779;margin-top:16px;">
      קישור זה תקף למשך 24 שעות.
    </p>
  `;
  return emailShell("אימות הרשמה - מערכת שיבוצים רמת גן", bodyHtml);
}

// 2. Password Reset Email
function passwordResetEmailHtml(username: string, resetLink: string): string {
  const bodyHtml = `
    <p style="margin:0 0 16px;">שלום ${escapeHtml(username)},</p>
    <p style="margin:0 0 18px;">
      התקבלה בקשה לאיפוס הסיסמה של חשבונך במערכת שיבוץ המשמרות. לחצו על הכפתור כדי לבחור סיסמה חדשה:
    </p>
    <p style="margin:0 0 20px;text-align:center;">
      <a href="${escapeHtml(resetLink)}" style="display:inline-block;background:#d97706;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;transition:background 0.2s;">
        איפוס הסיסמה
      </a>
    </p>
    <p style="font-size:12px;color:#5c5349;line-height:1.6;margin:0;">
      אם הכפתור אינו עובד, העתיקו את הקישור הבא לדפדפן שלכם:<br />
      <span style="direction:ltr;display:inline-block;word-break:break-all;background:#f5f1ea;padding:8px 10px;border-radius:4px;margin-top:8px;">
        ${escapeHtml(resetLink)}
      </span>
    </p>
    <p style="font-size:12px;color:#908779;margin-top:16px;">
      קישור זה תקף לשעה אחת בלבד.
    </p>
    <p style="font-size:12px;color:#908779;margin-top:12px;">
      <strong>לא ביקשתם לאפס סיסמה?</strong> ניתן להתעלם מהודעה זו. הסיסמה שלכם תישאר ללא שינוי.
    </p>
  `;
  return emailShell("איפוס סיסמה - מערכת שיבוצים רמת גן", bodyHtml);
}

// 3. Shift Request Reminder Email
function shiftRequestReminderEmailHtml(
  username: string,
  deadline: string,
  appLink: string
): string {
  const bodyHtml = `
    <p style="margin:0 0 16px;">שלום ${escapeHtml(username)},</p>
    <p style="margin:0 0 18px;">
      <strong>תזכורת:</strong> אתם מוזמנים להגיש את בקשות לסידור המשמרות שלכם.
    </p>
    <p style="margin:0 0 18px;">
      <strong>תאריך סיום:</strong> ${escapeHtml(deadline)}
    </p>
    <p style="margin:0 0 18px;">
      נא להכנס למערכת וליידי הגשת הבקשה שלכם לכל משמרות התקופה הקרובה.
    </p>
    <p style="margin:0 0 20px;text-align:center;">
      <a href="${escapeHtml(appLink)}" style="display:inline-block;background:#16a34a;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;transition:background 0.2s;">
        הגשת בקשות
      </a>
    </p>
    <p style="font-size:12px;color:#5c5349;line-height:1.6;margin:0;">
      אם הכפתור אינו עובד, העתיקו את הקישור:<br />
      <span style="direction:ltr;display:inline-block;word-break:break-all;background:#f5f1ea;padding:8px 10px;border-radius:4px;margin-top:8px;">
        ${escapeHtml(appLink)}
      </span>
    </p>
  `;
  return emailShell(
    "תזכורת: הגשת בקשות לסידור משמרות - רמת גן",
    bodyHtml
  );
}

// 4. Shift Change Notification Email
function shiftChangeNotificationEmailHtml(
  username: string,
  shiftDetails: string,
  appLink: string
): string {
  const bodyHtml = `
    <p style="margin:0 0 16px;">שלום ${escapeHtml(username)},</p>
    <p style="margin:0 0 18px;">
      <strong>עדכון חשוב:</strong> השיבוץ של משמרות שלכם עודכן במערכת.
    </p>
    <p style="margin:0 0 18px;background:#fff3cd;padding:12px;border-radius:8px;border-right:4px solid #ffc107;">
      ${shiftDetails}
    </p>
    <p style="margin:0 0 18px;">
      אנא הכנסו למערכת כדי לראות את השיבוץ המעודכן שלכם.
    </p>
    <p style="margin:0 0 20px;text-align:center;">
      <a href="${escapeHtml(appLink)}" style="display:inline-block;background:#0891b2;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;transition:background 0.2s;">
        צפיה בשיבוץ
      </a>
    </p>
    <p style="font-size:12px;color:#5c5349;line-height:1.6;margin:0;">
      אם הכפתור אינו עובד, העתיקו את הקישור:<br />
      <span style="direction:ltr;display:inline-block;word-break:break-all;background:#f5f1ea;padding:8px 10px;border-radius:4px;margin-top:8px;">
        ${escapeHtml(appLink)}
      </span>
    </p>
  `;
  return emailShell("עדכון: שינוי בשיבוץ המשמרת שלך", bodyHtml);
}

// 5. Schedule Publication Notification Email
function schedulePublishedEmailHtml(
  username: string,
  weekRange: string,
  appLink: string
): string {
  const bodyHtml = `
    <p style="margin:0 0 16px;">שלום ${escapeHtml(username)},</p>
    <p style="margin:0 0 18px;">
      <strong>פורסם סידור משמרות חדש!</strong> סידור המשמרות לשבוע ${escapeHtml(weekRange)} זו עכשיו זמין במערכת.
    </p>
    <p style="margin:0 0 18px;">
      בדקו את השיבוץ שלכם וודאו שאתם זמינים לכל המשמרות המוקצות לכם.
    </p>
    <p style="margin:0 0 20px;text-align:center;">
      <a href="${escapeHtml(appLink)}" style="display:inline-block;background:#7c3aed;color:#fff;text-decoration:none;font-weight:700;padding:14px 28px;border-radius:10px;transition:background 0.2s;">
        צפיה בסידור
      </a>
    </p>
    <p style="font-size:12px;color:#5c5349;line-height:1.6;margin:0;">
      אם הכפתור אינו עובד, העתיקו את הקישור:<br />
      <span style="direction:ltr;display:inline-block;word-break:break-all;background:#f5f1ea;padding:8px 10px;border-radius:4px;margin-top:8px;">
        ${escapeHtml(appLink)}
      </span>
    </p>
    <p style="font-size:12px;color:#908779;margin-top:16px;">
      אם יש בעיות או שאלות לגבי השיבוץ, בואו נדבר עם מנהל המערכת.
    </p>
  `;
  return emailShell("פורסם סידור משמרות חדש! - רמת גן", bodyHtml);
}

/* ==================== Main Handler ==================== */

type EmailRequest = {
  action: string;
  to: string;
  username?: string;
  actionUrl?: string;
  deadline?: string;
  shiftDetails?: string;
  weekRange?: string;
  appLink?: string;
  subject?: string;
  html?: string;
};

export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const body = (await req.json()) as EmailRequest;
    const { action, to, username = "משתמש" } = body;

    if (!action || !to) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: action and to" }),
        { status: 400, headers: { "content-type": "application/json" } }
      );
    }

    // Route based on action and build the email.
    let subject = "";
    let html = "";

    switch (action.toLowerCase()) {
      case "registration":
      case "verification": {
        if (!body.actionUrl) {
          return new Response(
            JSON.stringify({
              error:
                "Registration email requires actionUrl (verification link)",
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        subject = "אימות הרשמה - מערכת שיבוצים רמת גן";
        html = registrationEmailHtml(username, body.actionUrl);
        break;
      }

      case "passwordreset":
      case "reset": {
        if (!body.actionUrl) {
          return new Response(
            JSON.stringify({
              error: "Password reset email requires actionUrl (reset link)",
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        subject = "איפוס סיסמה - מערכת שיבוצים רמת גן";
        html = passwordResetEmailHtml(username, body.actionUrl);
        break;
      }

      case "requestreminder":
      case "reminder": {
        if (!body.deadline || !body.appLink) {
          return new Response(
            JSON.stringify({
              error:
                "Request reminder email requires deadline and appLink fields",
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        subject = "תזכורת: הגשת בקשות לסידור משמרות - רמת גן";
        html = shiftRequestReminderEmailHtml(username, body.deadline, body.appLink);
        break;
      }

      case "shiftchange":
      case "shift_change": {
        if (!body.shiftDetails || !body.appLink) {
          return new Response(
            JSON.stringify({
              error:
                "Shift change email requires shiftDetails and appLink fields",
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        subject = "עדכון: שינוי בשיבוץ המשמרת שלך";
        html = shiftChangeNotificationEmailHtml(
          username,
          body.shiftDetails,
          body.appLink
        );
        break;
      }

      case "schedulepublished":
      case "schedule_published": {
        if (!body.weekRange || !body.appLink) {
          return new Response(
            JSON.stringify({
              error:
                "Schedule published email requires weekRange and appLink fields",
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        subject = "פורסם סידור משמרות חדש! - רמת גן";
        html = schedulePublishedEmailHtml(username, body.weekRange, body.appLink);
        break;
      }

      case "generic":
      case "direct": {
        // Direct subject/html pass-through for backwards compatibility
        if (!body.subject || !body.html) {
          return new Response(
            JSON.stringify({
              error: "Generic email requires subject and html fields",
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          );
        }
        subject = body.subject;
        html = body.html;
        break;
      }

      default: {
        return new Response(
          JSON.stringify({
            error: `Unknown email action: ${action}. Valid actions: registration, passwordreset, requestreminder, shiftchange, schedulepublished, generic`,
          }),
          { status: 400, headers: { "content-type": "application/json" } }
        );
      }
    }

    // Send the email via Nodemailer/Brevo SMTP.
    const transporter = getTransporter();
    const senderEmail = process.env.SENDER_EMAIL || "noreply@mdaramatgan.com";
    const senderName = process.env.SENDER_NAME || "מערכת שיבוצים רמת גן";

    await transporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to,
      subject,
      html,
      replyTo: process.env.REPLY_TO_EMAIL || undefined,
    });

    return new Response(
      JSON.stringify({
        success: true,
        message: `Email sent successfully to ${to}`,
      }),
      {
        status: 200,
        headers: { "content-type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Email send error:", error);
    return new Response(
      JSON.stringify({
        error: error.message || "Failed to send email",
      }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      }
    );
  }
};

export const config: Config = {
  path: "/api/send-email",
};
