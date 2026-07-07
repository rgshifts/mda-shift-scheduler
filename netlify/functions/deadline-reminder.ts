// ============================================================
//  Scheduled function — Automated deadline email reminders
//  Runs on a cron and, when the weekly availability-submission deadline is within
//  the admin-configured window (X hours, default 24), emails every trainee who has
//  NOT yet submitted their availability for the week that closes at that deadline —
//  and drops a matching in-app "deadline_warning" notification into their bell.
//
//  It is self-contained on purpose: it shares the database and schema with the API
//  function but keeps its own tiny best-effort mailer so it never depends on the
//  API's request-scoped helpers. A given deadline is emailed exactly once — the
//  `settings.deadline_reminder_last_sent` watermark guards against the cron (which
//  fires every few minutes) re-sending for the same deadline.
// ============================================================
import type { Config } from "@netlify/functions";
import nodemailer from "nodemailer";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { users, roles, lockConfig, settings, availability, notifications } from "../../db/schema.js";

let smtpTransporter: nodemailer.Transporter | null = null;

function getSmtpTransporter(): nodemailer.Transporter {
  if (smtpTransporter) return smtpTransporter;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || "587", 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    throw new Error(
      "Missing SMTP configuration: SMTP_HOST, SMTP_USER, and SMTP_PASS are required"
    );
  }

  smtpTransporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  return smtpTransporter;
}

async function sendMail(to: string, subject: string, html: string): Promise<void> {
  const smtpConfigured =
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS;

  if (!smtpConfigured) {
    console.warn("deadline-reminder: SMTP not configured — skipping email to", to);
    return;
  }

  try {
    const transporter = getSmtpTransporter();
    const senderEmail = process.env.SENDER_EMAIL || "noreply@mdaramatgan.com";
    const senderName = process.env.SENDER_NAME || "מערכת שיבוצים רמת גן";

    await transporter.sendMail({
      from: `"${senderName}" <${senderEmail}>`,
      to,
      subject,
      html,
      replyTo: process.env.REPLY_TO_EMAIL || undefined,
    });
  } catch (err) {
    console.error("deadline-reminder: sendMail failed", err);
  }
}

function escapeHtml(s: string): string {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function reminderEmailHtml(name: string, deadlineLabel: string, hoursLeft: number, link: string): string {
  return `<!DOCTYPE html><html dir="rtl" lang="he"><body style="margin:0;background:#f3efe6;font-family:Arial,Helvetica,sans-serif;color:#211c19;">
  <div style="max-width:480px;margin:24px auto;background:#fffdf8;border:1px solid #e2dac9;border-radius:16px;padding:28px 26px;">
    <h1 style="font-size:20px;margin:0 0 14px;color:#1b3aa0;">תזכורת: הגשת אילוצים שבועית</h1>
    <p style="font-size:14px;line-height:1.6;margin:0 0 14px;">שלום ${escapeHtml(name)},</p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 14px;">טרם הגשת את האילוצים שלך לשבוע הקרוב. מועד ההגשה האחרון הוא <strong>${escapeHtml(deadlineLabel)}</strong> — נותרו כ-${hoursLeft} שעות.</p>
    <p style="font-size:14px;line-height:1.6;margin:0 0 18px;">נא להיכנס למערכת ולהגיש את האילוצים בהקדם כדי שנוכל לשבץ אותך בהתאם.</p>
    <p style="margin:0 0 18px;"><a href="${link}" style="display:inline-block;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:9px;">הגשת אילוצים</a></p>
    <p style="font-size:12px;color:#908779;margin-top:24px;">מערכת שיבוץ משמרות וחניכים — מד״א</p>
  </div></body></html>`;
}

/* ---------------- Jerusalem wall-clock helpers ----------------
   The lock deadline is stored as a weekday + "HH:MM" in Israel local time. These
   convert that wall-clock into a real UTC instant, correcting for the current
   Israel UTC offset (handles DST via Intl rather than a hard-coded +2/+3). */
function jerusalemParts(date: Date): { y: number; mo: number; d: number; h: number; mi: number; weekday: number } {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Jerusalem",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", weekday: "short", hour12: false,
  });
  const p: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) if (part.type !== "literal") p[part.type] = part.value;
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(p.year), mo: Number(p.month), d: Number(p.day),
    h: Number(p.hour) % 24, mi: Number(p.minute), weekday: weekdayMap[p.weekday] ?? 0,
  };
}

// UTC offset (minutes) of Asia/Jerusalem at the given instant.
function jerusalemOffsetMinutes(date: Date): number {
  const p = jerusalemParts(date);
  const asUTC = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, 0);
  return Math.round((asUTC - date.getTime()) / 60000);
}

// Convert a Jerusalem wall-clock (y, mo, d, H, M) to the matching UTC Date.
function jerusalemWallClockToUTC(y: number, mo: number, d: number, H: number, M: number): Date {
  const guess = Date.UTC(y, mo - 1, d, H, M, 0);
  const off = jerusalemOffsetMinutes(new Date(guess));
  return new Date(guess - off * 60000);
}

// ISO 'YYYY-MM-DD' for a Jerusalem wall-clock day advanced by `addDays`.
function jerusalemIso(base: { y: number; mo: number; d: number }, addDays: number): string {
  const t = Date.UTC(base.y, base.mo - 1, base.d + addDays);
  const dt = new Date(t);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const day = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export default async (_req: Request): Promise<void> => {
  // 1) The weekly lock must be enabled; without it there is no deadline to remind about.
  const lockRows = await db.select().from(lockConfig).where(eq(lockConfig.id, 1));
  const cfg = lockRows[0];
  if (!cfg || !cfg.enabled) return;

  // 2) Admin-configured window + the "already sent" watermark.
  const settingsRows = await db.select().from(settings).where(eq(settings.id, 1));
  const s = settingsRows[0];
  const rawHours = s ? Number(s.deadlineReminderHours) : 24;
  const hours = Number.isFinite(rawHours) && rawHours >= 1 ? Math.floor(rawHours) : 24;
  const lastSent = s ? String(s.deadlineReminderLastSent || "") : "";

  // 3) Compute the NEXT deadline instant from now (Jerusalem weekday + HH:MM).
  const now = new Date();
  const nowJ = jerusalemParts(now);
  const [dh, dm] = String(cfg.time || "20:00").split(":").map((x) => Number(x));
  let daysUntil = (cfg.day - nowJ.weekday + 7) % 7;
  let deadline = jerusalemWallClockToUTC(nowJ.y, nowJ.mo, nowJ.d + daysUntil, dh || 0, dm || 0);
  if (deadline.getTime() - now.getTime() <= 0) {
    // The deadline for `cfg.day` this week has already passed today — target next week's.
    daysUntil += 7;
    deadline = jerusalemWallClockToUTC(nowJ.y, nowJ.mo, nowJ.d + daysUntil, dh || 0, dm || 0);
  }

  // 4) Are we inside the reminder window [deadline − hours, deadline)?
  const msLeft = deadline.getTime() - now.getTime();
  if (msLeft <= 0 || msLeft > hours * 3600 * 1000) return;

  // 5) Guard: this exact deadline was already reminded for.
  const deadlineKey = deadline.toISOString();
  if (lastSent === deadlineKey) return;

  // 6) The submission week that closes at this deadline = the seven days of the
  //    week that STARTS on the Sunday after the deadline day.
  const dJ = jerusalemParts(deadline);
  let daysToSunday = (7 - cfg.day) % 7;
  if (daysToSunday === 0) daysToSunday = 7; // day===0 → target the following week
  const weekDates: string[] = [];
  for (let i = 0; i < 7; i++) weekDates.push(jerusalemIso({ y: dJ.y, mo: dJ.mo, d: dJ.d }, daysToSunday + i));

  // 7) Trainees = active accounts that are neither admins nor schedule-editing /
  //    role-managing roles (they are the ones who submit availability).
  const [userRows, roleRows, availRows] = await Promise.all([
    db.select().from(users),
    db.select().from(roles),
    db.select({ userId: availability.userId }).from(availability).where(inArray(availability.date, weekDates)),
  ]);
  const editorRoleNames = new Set(roleRows.filter((r) => r.canEditSchedule || r.canManageRoles).map((r) => r.name));
  const submitted = new Set<number>(availRows.map((a) => a.userId));
  const trainees = userRows.filter(
    (u) => u.activeTrainee !== false && u.role !== "admin" && !editorRoleNames.has(u.role),
  );
  const nonSubmitters = trainees.filter((u) => !submitted.has(u.id));

  if (!nonSubmitters.length) {
    // Nobody to remind, but still stamp the watermark so we don't re-scan this
    // deadline every few minutes.
    await db
      .insert(settings)
      .values({ id: 1, deadlineReminderLastSent: deadlineKey })
      .onConflictDoUpdate({ target: settings.id, set: { deadlineReminderLastSent: deadlineKey } });
    return;
  }

  const link = (process.env.URL || process.env.DEPLOY_PRIME_URL || process.env.DEPLOY_URL || "").replace(/\/+$/, "");
  const deadlineLabel = `${weekDates[0]} (יום ${["א׳", "ב׳", "ג׳", "ד׳", "ה׳", "ו׳", "שבת"][cfg.day] || ""} בשעה ${cfg.time})`;
  const hoursLeft = Math.max(1, Math.round(msLeft / 3600000));

  // 8) In-app bell notifications (one batch insert) + a reminder email each.
  try {
    await db.insert(notifications).values(
      nonSubmitters.map((u) => ({
        userId: u.id,
        type: "deadline_warning",
        title: "תזכורת: הגשת אילוצים",
        message: `טרם הגשת אילוצים לשבוע ${weekDates[0]}. מועד ההגשה: ${deadlineLabel}. נותרו כ-${hoursLeft} שעות.`,
      })),
    );
  } catch (err) {
    console.error("deadline-reminder: notification insert failed", err);
  }

  for (const u of nonSubmitters) {
    const email = (u.email || "").trim();
    if (!email) continue;
    await sendMail(
      email,
      "תזכורת: הגשת אילוצים שבועית — מערכת שיבוץ משמרות",
      reminderEmailHtml(u.fullName || email, deadlineLabel, hoursLeft, link),
    );
  }

  // 9) Stamp the watermark so this deadline is never reminded for twice.
  await db
    .insert(settings)
    .values({ id: 1, deadlineReminderLastSent: deadlineKey })
    .onConflictDoUpdate({ target: settings.id, set: { deadlineReminderLastSent: deadlineKey } });

  console.log(`deadline-reminder: sent ${nonSubmitters.length} reminder(s) for deadline ${deadlineKey}`);
};

// Fire every 15 minutes; the watermark ensures each deadline triggers exactly one
// batch even though the cron itself is frequent.
export const config: Config = {
  schedule: "*/15 * * * *",
};
