import crypto from "node:crypto";
import { promisify } from "node:util";
import { q } from "./db.mjs";

const scrypt = promisify(crypto.scrypt);

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const fail = (status, message) => {
  throw new HttpError(status, message);
};

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });

/* ---------- passwords ---------- */
export async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}
const DUMMY = "scrypt$00000000000000000000000000000000$" + "00".repeat(64);
export async function verifyPassword(pw, stored) {
  const [alg, saltHex, keyHex] = (stored || DUMMY).split("$");
  if (alg !== "scrypt") return false;
  const key = await scrypt(pw, Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  const ok = expected.length === key.length && crypto.timingSafeEqual(key, expected);
  return ok && stored != null;
}

/* ---------- signed session cookie ---------- */
function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 24) throw new Error("SESSION_SECRET env var must be set (24+ characters)");
  return s;
}
const b64 = (buf) => Buffer.from(buf).toString("base64url");
export function signSession(userId, days = 30) {
  const body = b64(JSON.stringify({ uid: userId, exp: Date.now() + days * 86400000 }));
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}
export function readSession(token) {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expect = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString());
    return p.exp > Date.now() ? p : null;
  } catch {
    return null;
  }
}
export function getCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
export const sessionCookie = (token) =>
  `sid=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`;
export const clearCookie = () => "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0";

/* ---------- rate limiting (stored in the database) ---------- */
export async function rateLimit(key, max, windowSec) {
  const rows = await q(
    `INSERT INTO rate_limits (key, window_start, count) VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       count = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::int) THEN 1 ELSE rate_limits.count + 1 END,
       window_start = CASE WHEN rate_limits.window_start < now() - make_interval(secs => $2::int) THEN now() ELSE rate_limits.window_start END
     RETURNING count`,
    [key, windowSec]
  );
  if (rows[0].count > max) fail(429, "Too many attempts. Please wait a few minutes and try again.");
}

/* ---------- audit log ---------- */
export const audit = (adminId, action, targetType, targetId, details = {}) =>
  q(`INSERT INTO audit_logs (admin_id, action, target_type, target_id, details) VALUES ($1,$2,$3,$4,$5)`, [
    adminId,
    action,
    targetType,
    targetId == null ? null : String(targetId),
    JSON.stringify(details),
  ]);

/* ---------- images ---------- */
export function sniffImage(buf) {
  const b = new Uint8Array(buf);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: "image/png", ext: "png" };
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return { type: "image/webp", ext: "webp" };
  return null;
}
