import { q } from "./db.mjs";

export const DEFAULT_SETTINGS = {
  notify_new_challenge: true,
  notify_approved: true,
  notify_rejected: true,
  notify_ending: true,
  reminder_hours: 24,
  email_enabled: true,
};

export async function getSettings() {
  const rows = await q(`SELECT key, value FROM settings`);
  const s = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in s) s[r.key] = r.value;
  return s;
}
export async function saveSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    await q(`INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [k, JSON.stringify(v)]);
  }
}

const SUBJECTS = {
  new_challenge: "New challenge is live",
  approved: "Submission approved",
  rejected: "Submission rejected",
  ending: "Time is running out",
};

const appUrl = () => (process.env.APP_URL || process.env.URL || "").replace(/\/$/, "");

async function sendEmails(messages) {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!key || !from || !messages.length) return;
  for (let i = 0; i < messages.length; i += 100) {
    const chunk = messages.slice(i, i + 100).map((m) => ({ from, to: [m.to], subject: m.subject, html: m.html }));
    try {
      const res = await fetch("https://api.resend.com/emails/batch", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(chunk),
      });
      if (!res.ok) console.error("Email send failed", res.status, await res.text());
    } catch (e) {
      console.error("Email send error", e);
    }
  }
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Create in-app notifications (and emails) for a list of {userId, message}.
 * Respects the admin's notification toggles. Never exposes anyone's email to anyone else.
 */
export async function notifyEach(type, list, link = "#/hunt") {
  if (!list.length) return;
  const settings = await getSettings();
  if (settings[`notify_${type}`] === false) return;
  const ids = list.map((l) => l.userId);
  const msgs = list.map((l) => l.message);
  await q(
    `INSERT INTO notifications (user_id, type, message, link)
     SELECT t.u, $3, t.m, $4 FROM unnest($1::int[], $2::text[]) AS t(u, m)`,
    [ids, msgs, type, link]
  );
  if (settings.email_enabled) {
    const users = await q(`SELECT id, email FROM users WHERE id = ANY($1::int[])`, [ids]);
    const emailOf = new Map(users.map((u) => [u.id, u.email]));
    const base = appUrl();
    const messages = list
      .filter((l) => emailOf.get(l.userId))
      .map((l) => ({
        to: emailOf.get(l.userId),
        subject: SUBJECTS[type] || "Weekly Hunt",
        html: `<div style="font-family:Arial,sans-serif;font-size:16px"><p>${esc(l.message)}</p>${
          base ? `<p><a href="${base}/${link}" style="background:#FFC800;color:#14110F;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:bold">Open the hunt</a></p>` : ""
        }</div>`,
      }));
    await sendEmails(messages);
  }
}
export const notify = (type, userIds, message, link) =>
  notifyEach(type, userIds.map((userId) => ({ userId, message })), link);

/** Runs on a schedule (and after publishing): announce new challenges and send ending reminders. */
export async function runLifecycle() {
  const settings = await getSettings();

  const started = await q(
    `UPDATE challenges SET start_notified = true
      WHERE status='published' AND start_at <= now() AND end_at > now() AND NOT start_notified
      RETURNING id, title`
  );
  for (const c of started) {
    const users = await q(`SELECT id FROM users WHERE role='participant' AND status='active'`);
    await notify("new_challenge", users.map((u) => u.id), `🚨 New challenge is live: ${c.title}! You've got 7 days. Good luck.`, "#/hunt");
  }

  const ending = await q(
    `UPDATE challenges SET end_notified = true
      WHERE status='published' AND start_at <= now() AND end_at > now()
        AND end_at <= now() + make_interval(hours => $1::int) AND NOT end_notified
      RETURNING id, title`,
    [settings.reminder_hours]
  );
  for (const c of ending) {
    const users = await q(
      `SELECT u.id,
              (SELECT count(*) FROM challenge_items i WHERE i.challenge_id=$1 AND NOT EXISTS (
                 SELECT 1 FROM submissions s WHERE s.item_id=i.id AND s.user_id=u.id AND s.status IN ('approved','pending')
              ))::int AS remaining
         FROM users u WHERE u.role='participant' AND u.status='active'`,
      [c.id]
    );
    const todo = users.filter((u) => u.remaining > 0);
    await notifyEach(
      "ending",
      todo.map((u) => ({
        userId: u.id,
        message: `⏰ ${settings.reminder_hours} hours left! You still have ${u.remaining} item${u.remaining === 1 ? "" : "s"} to complete.`,
      })),
      "#/hunt"
    );
  }
}
