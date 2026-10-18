import { getStore } from "@netlify/blobs";
import crypto from "node:crypto";
import { q } from "../lib/db.mjs";
import {
  HttpError, fail, json, hashPassword, verifyPassword, signSession, readSession, getCookie,
  sessionCookie, clearCookie, rateLimit, audit, sniffImage,
} from "../lib/util.mjs";
import { getActive, getUpcoming, getLastClosed, getChallenge, leaderboard, standings, userItems, DIFFICULTIES } from "../lib/game.mjs";
import { notify, getSettings, saveSettings, runLifecycle } from "../lib/notify.mjs";

export const config = { path: "/api/*" };

const MAX_PHOTO_BYTES = 4 * 1024 * 1024;
const photos = () => getStore("photos");

/* ---------------- router ---------------- */
const routes = [];
const route = (method, path, auth, fn) =>
  routes.push({ method, auth, fn, re: new RegExp("^" + path.replace(/:(\w+)/g, "(?<$1>[^/]+)") + "$") });

export default async (req, context) => {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, "") || "/";
    if (req.method !== "GET" && req.method !== "HEAD") {
      const origin = req.headers.get("origin");
      if (origin && new URL(origin).host !== url.host) fail(403, "Bad origin");
    }
    const r = routes.find((x) => x.method === req.method && x.re.test(path));
    if (!r) fail(404, "Not found");
    const params = path.match(r.re).groups || {};
    let user = null;
    if (r.auth !== "public") {
      user = await currentUser(req);
      if (!user) fail(401, "Please log in");
      if (r.auth === "admin" && user.role !== "admin") fail(403, "Admins only");
    }
    return await r.fn({ req, url, params, user, ip: context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown" });
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
};

async function currentUser(req) {
  const s = readSession(getCookie(req, "sid"));
  if (!s) return null;
  const r = await q(`SELECT id, nickname, email, role, status FROM users WHERE id=$1`, [s.uid]);
  return r[0] && r[0].status === "active" ? r[0] : null;
}
const int = (v, name = "id") => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(400, `Invalid ${name}`);
  return n;
};
const text = (v, max, name, required = false) => {
  const s = String(v ?? "").trim();
  if (required && !s) fail(400, `${name} is required`);
  if (s.length > max) fail(400, `${name} is too long (max ${max} characters)`);
  return s;
};
const body = async (req) => {
  try {
    return await req.json();
  } catch {
    return fail(400, "Invalid request");
  }
};
const phaseOf = (c) => {
  if (!c || c.status !== "published") return "draft";
  const now = Date.now();
  if (new Date(c.start_at) > now) return "upcoming";
  if (new Date(c.end_at) <= now) return "closed";
  return "active";
};
const publicChallenge = (c) => c && ({ id: c.id, title: c.title, description: c.description, rules: c.rules, start_at: c.start_at, end_at: c.end_at });

/* ---------------- auth ---------------- */
route("POST", "/auth/register", "public", async ({ req, ip }) => {
  await rateLimit(`reg:${ip}`, 10, 3600);
  const b = await body(req);
  const nickname = text(b.nickname, 20, "Nickname", true);
  if (!/^[A-Za-z0-9_.\- ]{2,20}$/.test(nickname)) fail(400, "Nickname must be 2-20 letters, numbers, spaces, _ . or -");
  const email = text(b.email, 200, "Email", true).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400, "Enter a valid email address");
  const password = String(b.password || "");
  if (password.length < 8) fail(400, "Password must be at least 8 characters");
  if (password.length > 200) fail(400, "Password is too long");
  if (password !== b.confirm) fail(400, "Passwords do not match");
  const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const role = adminEmail && email === adminEmail ? "admin" : "participant";
  let row;
  try {
    row = (await q(`INSERT INTO users (nickname, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id`, [nickname, email, await hashPassword(password), role]))[0];
  } catch (e) {
    if (e.code === "23505") fail(409, String(e.constraint || e.message).includes("nickname") ? "That nickname is taken" : "That email is already registered");
    throw e;
  }
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(signSession(row.id)) });
});

route("POST", "/auth/login", "public", async ({ req, ip }) => {
  const b = await body(req);
  const email = String(b.email || "").trim().toLowerCase().slice(0, 200);
  await rateLimit(`login:${ip}:${email}`, 8, 600);
  await rateLimit(`login-ip:${ip}`, 40, 600);
  const u = (await q(`SELECT id, password_hash, status FROM users WHERE lower(email)=$1`, [email]))[0];
  const ok = await verifyPassword(String(b.password || ""), u?.password_hash);
  if (!u || !ok) fail(401, "Wrong email or password");
  if (u.status !== "active") fail(403, "This account has been disabled");
  return json({ ok: true }, 200, { "Set-Cookie": sessionCookie(signSession(u.id)) });
});

route("POST", "/auth/logout", "public", async () => json({ ok: true }, 200, { "Set-Cookie": clearCookie() }));

route("GET", "/me", "public", async ({ req }) => {
  const user = await currentUser(req);
  if (!user) return json({ user: null, now: Date.now() });
  const n = await q(`SELECT count(*)::int AS c FROM notifications WHERE user_id=$1 AND NOT read`, [user.id]);
  return json({ user: { id: user.id, nickname: user.nickname, role: user.role }, unread: n[0].c, now: Date.now() });
});

/* ---------------- participant ---------------- */
route("GET", "/dashboard", "user", async ({ user }) => {
  const active = await getActive();
  const upcoming = await getUpcoming();
  const challenge = active || (await getLastClosed());
  const out = { now: Date.now(), phase: active ? "active" : challenge ? "closed" : "none", upcoming: upcoming && publicChallenge(upcoming), is_admin: user.role === "admin" };
  if (!challenge) return json(out);
  const items = await userItems(challenge.id, user.id);
  const st = await standings(challenge, user.id);
  const recent = await q(
    `SELECT s.id, s.status, s.submitted_at, s.reviewed_at, s.rejection_reason, i.title, i.points
       FROM submissions s JOIN challenge_items i ON i.id=s.item_id
      WHERE s.user_id=$1 AND i.challenge_id=$2
        AND NOT (s.status='rejected' AND EXISTS (SELECT 1 FROM submissions x WHERE x.user_id=s.user_id AND x.item_id=s.item_id AND x.status IN ('pending','approved')))
      ORDER BY COALESCE(s.reviewed_at, s.submitted_at) DESC LIMIT 30`,
    [user.id, challenge.id]
  );
  return json({
    ...out,
    challenge: publicChallenge(challenge),
    score: st.me?.points ?? 0,
    rank: st.me?.rank ?? null,
    total: st.total,
    gap: st.me?.gap ?? 0,
    above: st.me?.above ?? null,
    items_done: items.filter((i) => i.status === "approved").length,
    items_total: items.length,
    pending: items.filter((i) => i.status === "pending").length,
    recent,
    leaderboard: st.rows.slice(0, 10),
  });
});

route("GET", "/challenge/current", "user", async ({ user }) => {
  const active = await getActive();
  if (!active) {
    const upcoming = await getUpcoming();
    return json({ phase: upcoming ? "upcoming" : "none", upcoming: upcoming && publicChallenge(upcoming), now: Date.now() });
  }
  return json({ phase: "active", challenge: publicChallenge(active), items: await userItems(active.id, user.id), now: Date.now() });
});

route("POST", "/items/:id/submit", "user", async ({ req, params, user }) => {
  if (user.role !== "participant") fail(403, "Admins cannot submit photos");
  await rateLimit(`submit:${user.id}`, 30, 600);
  const itemId = int(params.id);
  const item = (await q(`SELECT i.id, i.challenge_id FROM challenge_items i WHERE i.id=$1`, [itemId]))[0];
  if (!item) fail(404, "Item not found");
  const c = await getChallenge(item.challenge_id);
  if (phaseOf(c) !== "active") fail(409, "This challenge is not open for submissions");
  const existing = await q(`SELECT status FROM submissions WHERE user_id=$1 AND item_id=$2 AND status IN ('pending','approved')`, [user.id, itemId]);
  if (existing[0]) fail(409, existing[0].status === "approved" ? "This item is already approved" : "You already have a submission waiting for review");

  const len = Number(req.headers.get("content-length") || 0);
  if (len > 6 * 1024 * 1024) fail(413, "Photos are too large");
  let form;
  try {
    form = await req.formData();
  } catch {
    fail(400, "Invalid upload");
  }
  const bufs = [];
  for (const field of ["photo1", "photo2"]) {
    const f = form.get(field);
    if (!f || typeof f === "string") fail(400, "Both photos are required");
    if (f.size > MAX_PHOTO_BYTES) fail(413, "Each photo must be under 4 MB");
    const buf = await f.arrayBuffer();
    const kind = sniffImage(buf);
    if (!kind) fail(400, "Photos must be JPEG, PNG or WebP images");
    bufs.push({ buf, kind });
  }
  const store = photos();
  const keys = [];
  for (const { buf, kind } of bufs) {
    const key = `sub/${user.id}/${crypto.randomUUID()}.${kind.ext}`;
    await store.set(key, buf, { metadata: { type: kind.type } });
    keys.push(key);
  }
  try {
    const r = await q(`INSERT INTO submissions (user_id, item_id, photo_1_key, photo_2_key) VALUES ($1,$2,$3,$4) RETURNING id`, [user.id, itemId, keys[0], keys[1]]);
    return json({ ok: true, id: r[0].id });
  } catch (e) {
    await Promise.allSettled(keys.map((k) => store.delete(k)));
    if (e.code === "23505") fail(409, "You already have a submission for this item");
    throw e;
  }
});

route("GET", "/photo/:id/:n", "user", async ({ params, user }) => {
  const id = int(params.id);
  const s = (await q(`SELECT user_id, photo_1_key, photo_2_key FROM submissions WHERE id=$1`, [id]))[0];
  if (!s || (s.user_id !== user.id && user.role !== "admin")) fail(404, "Not found");
  const key = params.n === "2" ? s.photo_2_key : s.photo_1_key;
  const res = await photos().getWithMetadata(key, { type: "arrayBuffer" });
  if (!res) fail(404, "Not found");
  return new Response(res.data, {
    headers: { "Content-Type": res.metadata?.type || "image/jpeg", "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff" },
  });
});

route("GET", "/leaderboard", "user", async ({ user }) => {
  const active = await getActive();
  const challenge = active || (await getLastClosed());
  if (!challenge) return json({ phase: "none" });
  return json({ phase: active ? "active" : "closed", challenge: publicChallenge(challenge), ...(await standings(challenge, user.id)), now: Date.now() });
});

route("GET", "/results", "user", async ({ user }) => {
  const rows = await q(`SELECT id, title, start_at, end_at FROM challenges WHERE status='published' AND end_at <= now() ORDER BY end_at DESC LIMIT 100`);
  const out = [];
  for (const c of rows) {
    const st = await standings(c, user.id);
    out.push({ ...c, winner: st.rows[0]?.points > 0 ? st.rows[0].nickname : null, my_rank: st.me?.rank ?? null, my_points: st.me?.points ?? 0 });
  }
  return json({ results: out });
});

route("GET", "/results/:id", "user", async ({ params, user }) => {
  const c = await getChallenge(int(params.id));
  if (!c || c.status !== "published" || phaseOf(c) !== "closed") fail(404, "Results not available");
  const st = await standings(c, user.id);
  const items = await userItems(c.id, user.id);
  const pending = await q(`SELECT count(*)::int AS n FROM submissions s JOIN challenge_items i ON i.id=s.item_id WHERE i.challenge_id=$1 AND s.status='pending'`, [c.id]);
  const approved = await q(
    `SELECT i.title, i.points, s.reviewed_at, s.submitted_at FROM submissions s JOIN challenge_items i ON i.id=s.item_id
      WHERE s.user_id=$1 AND i.challenge_id=$2 AND s.status='approved' ORDER BY s.submitted_at`,
    [user.id, c.id]
  );
  return json({
    challenge: publicChallenge(c),
    finalized: pending[0].n === 0,
    rows: st.rows,
    me: st.me,
    completed: items.filter((i) => i.status === "approved").map((i) => ({ title: i.title, points: i.points })),
    missed: items.filter((i) => i.status !== "approved").map((i) => ({ title: i.title, points: i.points })),
    approved,
  });
});

route("GET", "/notifications", "user", async ({ user }) => {
  const rows = await q(`SELECT id, type, message, link, read, created_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 40`, [user.id]);
  return json({ notifications: rows });
});
route("POST", "/notifications/read", "user", async ({ user }) => {
  await q(`UPDATE notifications SET read=true WHERE user_id=$1 AND NOT read`, [user.id]);
  return json({ ok: true });
});

/* ---------------- admin: overview & review ---------------- */
route("GET", "/admin/overview", "admin", async () => {
  const active = await getActive();
  const upcoming = await getUpcoming();
  const challenge = active || (await getLastClosed());
  const participants = (await q(`SELECT count(*)::int AS n FROM users WHERE role='participant' AND status='active'`))[0].n;
  const pendingAll = (await q(`SELECT count(*)::int AS n FROM submissions WHERE status='pending'`))[0].n;
  let counts = { total: 0, pending: 0, approved: 0, rejected: 0 };
  let rows = [];
  if (challenge) {
    counts = (
      await q(
        `SELECT count(*)::int AS total,
                (count(*) FILTER (WHERE s.status='pending'))::int AS pending,
                (count(*) FILTER (WHERE s.status='approved'))::int AS approved,
                (count(*) FILTER (WHERE s.status='rejected'))::int AS rejected
           FROM submissions s JOIN challenge_items i ON i.id=s.item_id WHERE i.challenge_id=$1`,
        [challenge.id]
      )
    )[0];
    rows = (await leaderboard(challenge.id)).slice(0, 15).map((r) => ({ rank: r.rank, nickname: r.nickname, points: r.points, items: r.items }));
  }
  return json({ phase: active ? "active" : challenge ? "closed" : "none", challenge: publicChallenge(challenge), upcoming: upcoming && publicChallenge(upcoming), participants, counts, pending_all: pendingAll, leaderboard: rows, now: Date.now() });
});

const SUB_SELECT = `
  SELECT s.id, s.status, s.submitted_at, s.reviewed_at, s.rejection_reason, u.nickname,
         i.title AS item_title, i.instructions, i.points, c.title AS challenge_title,
         (SELECT coalesce(json_agg(json_build_object('reason', x.rejection_reason, 'at', x.reviewed_at) ORDER BY x.reviewed_at), '[]'::json)
            FROM submissions x WHERE x.user_id=s.user_id AND x.item_id=s.item_id AND x.status='rejected' AND x.id<>s.id) AS history
    FROM submissions s JOIN users u ON u.id=s.user_id JOIN challenge_items i ON i.id=s.item_id JOIN challenges c ON c.id=i.challenge_id`;

route("GET", "/admin/review", "admin", async () => json({ queue: await q(`${SUB_SELECT} WHERE s.status='pending' ORDER BY s.submitted_at ASC LIMIT 100`) }));

route("GET", "/admin/submissions", "admin", async ({ url }) => {
  const status = url.searchParams.get("status") || null;
  const challenge = url.searchParams.get("challenge") ? int(url.searchParams.get("challenge")) : null;
  const term = (url.searchParams.get("q") || "").trim();
  const like = term ? `%${term.replace(/[%_]/g, "")}%` : null;
  if (status && !["pending", "approved", "rejected"].includes(status)) fail(400, "Bad status");
  const rows = await q(
    `${SUB_SELECT} WHERE ($1::text IS NULL OR s.status=$1) AND ($2::int IS NULL OR i.challenge_id=$2)
       AND ($3::text IS NULL OR u.nickname ILIKE $3 OR i.title ILIKE $3) ORDER BY s.submitted_at DESC LIMIT 100`,
    [status, challenge, like]
  );
  return json({ submissions: rows });
});

route("POST", "/admin/submissions/:id/approve", "admin", async ({ params, user }) => {
  const id = int(params.id);
  const r = await q(
    `WITH upd AS (
       UPDATE submissions SET status='approved', reviewed_at=now(), reviewed_by=$2, rejection_reason=NULL
        WHERE id=$1 AND status='pending' RETURNING id, user_id, item_id, submitted_at
     ), ins AS (
       INSERT INTO point_transactions (user_id, challenge_id, item_id, submission_id, points, transaction_type, earned_at)
       SELECT upd.user_id, i.challenge_id, i.id, upd.id, i.points, 'approval', upd.submitted_at
         FROM upd JOIN challenge_items i ON i.id = upd.item_id
       RETURNING points
     )
     SELECT upd.user_id, upd.item_id, (SELECT points FROM ins) AS points FROM upd`,
    [id, user.id]
  );
  if (!r[0]) fail(409, "This submission was already reviewed");
  const item = (await q(`SELECT title FROM challenge_items WHERE id=$1`, [r[0].item_id]))[0];
  await audit(user.id, "approve_submission", "submission", id, { points: r[0].points, item: item?.title });
  await notify("approved", [r[0].user_id], `✅ Your submission for '${item?.title}' was approved. +${r[0].points} points!`, "#/");
  return json({ ok: true });
});

route("POST", "/admin/submissions/:id/reject", "admin", async ({ req, params, user }) => {
  const id = int(params.id);
  const b = await body(req);
  const reason = text(b.reason, 300, "Rejection reason", true);
  if (reason.length < 3) fail(400, "Give the participant a reason");
  const r = await q(
    `UPDATE submissions SET status='rejected', reviewed_at=now(), reviewed_by=$2, rejection_reason=$3
      WHERE id=$1 AND status='pending' RETURNING user_id, item_id`,
    [id, user.id, reason]
  );
  if (!r[0]) fail(409, "This submission was already reviewed");
  const item = (await q(`SELECT title FROM challenge_items WHERE id=$1`, [r[0].item_id]))[0];
  await audit(user.id, "reject_submission", "submission", id, { reason, item: item?.title });
  await notify("rejected", [r[0].user_id], `❌ Your submission for '${item?.title}' was rejected. Tap to see why and resubmit.`, "#/hunt");
  return json({ ok: true });
});

/* ---------------- admin: challenges & items ---------------- */
function parseChallenge(b) {
  const title = text(b.title, 120, "Challenge name", true);
  const start = new Date(b.start_at), end = new Date(b.end_at);
  if (isNaN(start) || isNaN(end)) fail(400, "Set a valid start and end time");
  if (end <= start) fail(400, "End time must be after the start time");
  return { title, description: text(b.description, 2000, "Description"), rules: text(b.rules, 4000, "Rules"), start: start.toISOString(), end: end.toISOString() };
}
function parseItem(b) {
  const points = Number(b.points);
  if (!Number.isInteger(points) || points < 0 || points > 10000) fail(400, "Points must be a whole number from 0 to 10000");
  const difficulty = String(b.difficulty || "easy").toLowerCase();
  if (!DIFFICULTIES.includes(difficulty)) fail(400, "Pick a valid difficulty");
  return {
    title: text(b.title, 160, "Item name", true),
    description: text(b.description, 1000, "Description"),
    instructions: text(b.instructions, 2000, "Instructions"),
    difficulty,
    points,
    hint: text(b.hint, 500, "Hint") || null,
  };
}

route("GET", "/admin/challenges", "admin", async () => {
  const rows = await q(
    `SELECT c.id, c.title, c.status, c.start_at, c.end_at,
            (SELECT count(*) FROM challenge_items WHERE challenge_id=c.id)::int AS item_count,
            (SELECT count(*) FROM submissions s JOIN challenge_items i ON i.id=s.item_id WHERE i.challenge_id=c.id)::int AS submission_count
       FROM challenges c WHERE c.status <> 'archived' ORDER BY c.start_at DESC`
  );
  return json({ challenges: rows.map((c) => ({ ...c, phase: phaseOf(c) })) });
});
route("GET", "/admin/challenges/:id", "admin", async ({ params }) => {
  const c = await getChallenge(int(params.id));
  if (!c) fail(404, "Challenge not found");
  const items = await q(`SELECT * FROM challenge_items WHERE challenge_id=$1 ORDER BY display_order, id`, [c.id]);
  const subs = (await q(`SELECT count(*)::int AS n FROM submissions s JOIN challenge_items i ON i.id=s.item_id WHERE i.challenge_id=$1`, [c.id]))[0].n;
  return json({ challenge: { ...c, phase: phaseOf(c), submission_count: subs }, items });
});
route("POST", "/admin/challenges", "admin", async ({ req, user }) => {
  const c = parseChallenge(await body(req));
  const r = await q(`INSERT INTO challenges (title, description, rules, start_at, end_at) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [c.title, c.description, c.rules, c.start, c.end]);
  await audit(user.id, "create_challenge", "challenge", r[0].id, { title: c.title });
  return json({ id: r[0].id });
});
route("PUT", "/admin/challenges/:id", "admin", async ({ req, params, user }) => {
  const id = int(params.id);
  const c = parseChallenge(await body(req));
  const cur = await getChallenge(id);
  if (!cur) fail(404, "Challenge not found");
  if (cur.status === "published") {
    const clash = await q(`SELECT 1 FROM challenges WHERE status='published' AND id<>$1 AND start_at < $3 AND end_at > $2 LIMIT 1`, [id, c.start, c.end]);
    if (clash[0]) fail(409, "These dates overlap another published challenge");
  }
  await q(`UPDATE challenges SET title=$2, description=$3, rules=$4, start_at=$5, end_at=$6 WHERE id=$1`, [id, c.title, c.description, c.rules, c.start, c.end]);
  await audit(user.id, "edit_challenge", "challenge", id, { title: c.title });
  return json({ ok: true });
});
route("DELETE", "/admin/challenges/:id", "admin", async ({ params, user }) => {
  const id = int(params.id);
  const subs = (await q(`SELECT count(*)::int AS n FROM submissions s JOIN challenge_items i ON i.id=s.item_id WHERE i.challenge_id=$1`, [id]))[0].n;
  if (subs > 0) {
    await q(`UPDATE challenges SET status='archived' WHERE id=$1`, [id]);
    await audit(user.id, "archive_challenge", "challenge", id);
    return json({ ok: true, result: "archived" });
  }
  await q(`DELETE FROM challenges WHERE id=$1`, [id]);
  await audit(user.id, "delete_challenge", "challenge", id);
  return json({ ok: true, result: "deleted" });
});
route("POST", "/admin/challenges/:id/publish", "admin", async ({ params, user }) => {
  const id = int(params.id);
  const c = await getChallenge(id);
  if (!c) fail(404, "Challenge not found");
  const n = (await q(`SELECT count(*)::int AS n FROM challenge_items WHERE challenge_id=$1`, [id]))[0].n;
  if (n === 0) fail(400, "Add at least one item before publishing");
  if (new Date(c.end_at) <= Date.now()) fail(400, "The end time is already in the past. Edit the dates first.");
  const clash = await q(`SELECT title FROM challenges WHERE status='published' AND id<>$1 AND start_at < $3 AND end_at > $2 LIMIT 1`, [id, c.start_at, c.end_at]);
  if (clash[0]) fail(409, `These dates overlap "${clash[0].title}". Only one challenge can run at a time.`);
  await q(`UPDATE challenges SET status='published' WHERE id=$1`, [id]);
  await audit(user.id, "publish_challenge", "challenge", id);
  await runLifecycle().catch((e) => console.error(e));
  return json({ ok: true });
});
route("POST", "/admin/challenges/:id/unpublish", "admin", async ({ params, user }) => {
  const id = int(params.id);
  await q(`UPDATE challenges SET status='draft' WHERE id=$1 AND status='published'`, [id]);
  await audit(user.id, "unpublish_challenge", "challenge", id);
  return json({ ok: true });
});
route("POST", "/admin/challenges/:id/items", "admin", async ({ req, params, user }) => {
  const id = int(params.id);
  const it = parseItem(await body(req));
  if (!(await getChallenge(id))) fail(404, "Challenge not found");
  const r = await q(
    `INSERT INTO challenge_items (challenge_id, title, description, instructions, difficulty, points, hint, display_order)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE((SELECT max(display_order)+1 FROM challenge_items WHERE challenge_id=$1),1)) RETURNING id`,
    [id, it.title, it.description, it.instructions, it.difficulty, it.points, it.hint]
  );
  await audit(user.id, "add_item", "item", r[0].id, { title: it.title, points: it.points });
  return json({ id: r[0].id });
});
route("PUT", "/admin/items/:id", "admin", async ({ req, params, user }) => {
  const id = int(params.id);
  const it = parseItem(await body(req));
  await q(`UPDATE challenge_items SET title=$2, description=$3, instructions=$4, difficulty=$5, points=$6, hint=$7 WHERE id=$1`, [id, it.title, it.description, it.instructions, it.difficulty, it.points, it.hint]);
  await audit(user.id, "edit_item", "item", id, { title: it.title, points: it.points });
  return json({ ok: true });
});
route("DELETE", "/admin/items/:id", "admin", async ({ params, user }) => {
  const id = int(params.id);
  const subs = (await q(`SELECT count(*)::int AS n FROM submissions WHERE item_id=$1`, [id]))[0].n;
  if (subs > 0) fail(409, "This item already has submissions, so it can't be deleted");
  await q(`DELETE FROM challenge_items WHERE id=$1`, [id]);
  await audit(user.id, "delete_item", "item", id);
  return json({ ok: true });
});

/* ---------------- admin: users ---------------- */
route("GET", "/admin/users", "admin", async ({ url }) => {
  const term = (url.searchParams.get("q") || "").trim();
  const like = term ? `%${term.replace(/[%_]/g, "")}%` : null;
  const active = await getActive();
  const rows = await q(
    `SELECT u.id, u.nickname, u.email, u.role, u.status, u.created_at,
            (SELECT count(*) FROM submissions s WHERE s.user_id=u.id)::int AS submissions,
            (SELECT count(*) FROM submissions s WHERE s.user_id=u.id AND s.status='approved')::int AS approved,
            COALESCE((SELECT sum(points) FROM point_transactions p WHERE p.user_id=u.id AND p.challenge_id=$2),0)::int AS score
       FROM users u WHERE ($1::text IS NULL OR u.nickname ILIKE $1 OR u.email ILIKE $1) ORDER BY u.created_at DESC LIMIT 200`,
    [like, active ? active.id : null]
  );
  return json({ users: rows, active_challenge: active ? { id: active.id, title: active.title } : null });
});
route("POST", "/admin/users/:id/status", "admin", async ({ req, params, user }) => {
  const id = int(params.id);
  const b = await body(req);
  if (!["active", "disabled"].includes(b.status)) fail(400, "Bad status");
  if (id === user.id) fail(400, "You can't change your own account");
  const r = await q(`UPDATE users SET status=$2 WHERE id=$1 AND role='participant' RETURNING nickname`, [id, b.status]);
  if (!r[0]) fail(404, "Participant not found");
  await audit(user.id, b.status === "disabled" ? "disable_user" : "enable_user", "user", id, { nickname: r[0].nickname });
  return json({ ok: true });
});
route("DELETE", "/admin/users/:id", "admin", async ({ params, user }) => {
  const id = int(params.id);
  if (id === user.id) fail(400, "You can't remove your own account");
  const u = (await q(`SELECT nickname, role FROM users WHERE id=$1`, [id]))[0];
  if (!u || u.role !== "participant") fail(404, "Participant not found");
  const subs = await q(`SELECT photo_1_key, photo_2_key FROM submissions WHERE user_id=$1`, [id]);
  await q(`DELETE FROM users WHERE id=$1`, [id]);
  const store = photos();
  await Promise.allSettled(subs.flatMap((s) => [store.delete(s.photo_1_key), store.delete(s.photo_2_key)]));
  await audit(user.id, "remove_user", "user", id, { nickname: u.nickname });
  return json({ ok: true });
});
route("POST", "/admin/users/:id/adjust", "admin", async ({ req, params, user }) => {
  const id = int(params.id);
  const b = await body(req);
  const newScore = Number(b.new_score);
  if (!Number.isInteger(newScore) || newScore < 0 || newScore > 1000000) fail(400, "Enter a whole number for the new score");
  const reason = text(b.reason, 300, "Reason", true);
  const challenge = b.challenge_id ? await getChallenge(int(b.challenge_id)) : await getActive();
  if (!challenge) fail(400, "There is no active challenge to adjust");
  const u = (await q(`SELECT nickname FROM users WHERE id=$1 AND role='participant'`, [id]))[0];
  if (!u) fail(404, "Participant not found");
  const prev = (await q(`SELECT COALESCE(sum(points),0)::int AS s FROM point_transactions WHERE user_id=$1 AND challenge_id=$2`, [id, challenge.id]))[0].s;
  const diff = newScore - prev;
  if (diff === 0) fail(400, "The score is already that value");
  await q(`INSERT INTO point_transactions (user_id, challenge_id, points, transaction_type) VALUES ($1,$2,$3,'adjustment')`, [id, challenge.id, diff]);
  await audit(user.id, "adjust_score", "user", id, { participant: u.nickname, challenge: challenge.title, previous: prev, new: newScore, difference: diff, reason });
  return json({ ok: true, previous: prev, new: newScore, difference: diff });
});

/* ---------------- admin: audit & settings ---------------- */
route("GET", "/admin/audit", "admin", async () => {
  const rows = await q(`SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.created_at, u.nickname AS admin FROM audit_logs a LEFT JOIN users u ON u.id=a.admin_id ORDER BY a.created_at DESC LIMIT 150`);
  return json({ logs: rows });
});
route("GET", "/admin/settings", "admin", async () => json({ settings: await getSettings(), email_configured: Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM) }));
route("PUT", "/admin/settings", "admin", async ({ req, user }) => {
  const b = await body(req);
  const patch = {};
  for (const k of ["notify_new_challenge", "notify_approved", "notify_rejected", "notify_ending", "email_enabled"]) if (k in b) patch[k] = Boolean(b[k]);
  if ("reminder_hours" in b) {
    const h = Number(b.reminder_hours);
    if (!Number.isInteger(h) || h < 1 || h > 72) fail(400, "Reminder must be between 1 and 72 hours");
    patch.reminder_hours = h;
  }
  await saveSettings(patch);
  await audit(user.id, "update_settings", "settings", null, patch);
  return json({ ok: true });
});
