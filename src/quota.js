// Prompt quota for the public site.
//
//   tailnet   a valid tailnet pass (x-ai-pass) → unlimited. Passes are minted by
//             tools/tailnet-pass.py, which only listens on a Tailscale address, and
//             signed with PASS_SECRET (HMAC-SHA256).
//   approved  the owner approved this visitor on /admin → unlimited.
//   free      everyone else gets FREE_PROMPTS (default 10) chats. Counted per
//             visitor id (x-ai-visitor, random, kept in the browser) AND per IP, so
//             clearing the browser doesn't reset it. Then they can ask for access.
//   pending   asked for access, waiting for the owner.
//   denied    the owner said no.
//
// State lives in D1 (env.DB). Counting is not transactional: two simultaneous
// chats at prompt 9 can both get through. That's fine for a home lab.

export const VISITOR = /^[A-Za-z0-9-]{16,64}$/;
const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

export const freePrompts = (env) => {
  const n = Number.parseInt(env.FREE_PROMPTS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 10;
};

const hmacKey = (secret) => crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);

// Token: base64url(JSON {dev, user, exp}) + "." + base64url(HMAC-SHA256(payload part)).
export async function signPass(claims, secret) {
  const p = b64url(enc.encode(JSON.stringify(claims)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(p));
  return `${p}.${b64url(sig)}`;
}

// -> {dev, user} for a valid, unexpired pass; null otherwise (never throws).
export async function verifyPass(token, secret) {
  if (!token || !secret || token.length > 2048) return null;
  try {
    const [p, sig, extra] = token.split(".");
    if (!p || !sig || extra !== undefined) return null;
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(sig), enc.encode(p));
    if (!ok) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    if (typeof c.exp !== "number" || c.exp <= Math.floor(Date.now() / 1000)) return null;
    return { dev: String(c.dev ?? ""), user: String(c.user ?? "") };
  } catch {
    return null;
  }
}

const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS visitors (id TEXT PRIMARY KEY, ip TEXT, prompts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'free', name TEXT, note TEXT, created TEXT NOT NULL, updated TEXT NOT NULL, requested TEXT)",
  "CREATE TABLE IF NOT EXISTS ips (ip TEXT PRIMARY KEY, prompts INTEGER NOT NULL DEFAULT 0, updated TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS visitors_status ON visitors(status)",
];
let schemaReady = null;
export const ensureSchema = (db) =>
  (schemaReady ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => { schemaReady = null; throw e; }));
export const _resetSchema = () => { schemaReady = null; };

const now = () => new Date().toISOString();
export const clientIp = (request) => request.headers.get("cf-connecting-ip") || "unknown";

// Works out who's asking and what they're allowed. Never writes.
export async function standing(request, env) {
  const limit = freePrompts(env);
  const passToken = request.headers.get("x-ai-pass");
  const pass = await verifyPass(passToken, env.PASS_SECRET);
  const base = { limit, pass, passInvalid: !!passToken && !pass };
  if (pass) return { ...base, tier: "tailnet", used: 0, remaining: null };

  const visitor = request.headers.get("x-ai-visitor") || "";
  if (!VISITOR.test(visitor)) return { ...base, tier: "invalid", used: 0, remaining: 0 };

  const db = env.DB;
  await ensureSchema(db);
  const ip = clientIp(request);
  const [v, i] = await Promise.all([
    db.prepare("SELECT prompts, status FROM visitors WHERE id = ?").bind(visitor).first(),
    db.prepare("SELECT prompts FROM ips WHERE ip = ?").bind(ip).first(),
  ]);
  const status = v?.status ?? "free";
  const used = Math.max(v?.prompts ?? 0, i?.prompts ?? 0);
  if (status === "approved") return { ...base, tier: "approved", used, remaining: null, visitor, ip };
  if (status === "denied") return { ...base, tier: "denied", used, remaining: 0, visitor, ip };
  const remaining = Math.max(0, limit - used);
  // "pending" only matters once the free prompts are gone.
  const tier = remaining > 0 ? "free" : status === "pending" ? "pending" : "exhausted";
  return { ...base, tier, used, remaining, visitor, ip, status };
}

export const unlimited = (s) => s.tier === "tailnet" || s.tier === "approved";
export const canChat = (s) => unlimited(s) || (s.tier === "free" && s.remaining > 0);

// Counts one prompt against the visitor and their IP. Tailnet use isn't recorded.
export async function consume(env, s) {
  if (s.tier === "tailnet") return;
  const t = now();
  if (s.tier === "approved") {
    await env.DB.prepare("UPDATE visitors SET prompts = prompts + 1, updated = ? WHERE id = ?").bind(t, s.visitor).run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO visitors (id, ip, prompts, created, updated) VALUES (?, ?, 1, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET prompts = prompts + 1, ip = excluded.ip, updated = excluded.updated",
    ).bind(s.visitor, s.ip, t, t),
    env.DB.prepare(
      "INSERT INTO ips (ip, prompts, updated) VALUES (?, 1, ?) ON CONFLICT(ip) DO UPDATE SET prompts = prompts + 1, updated = excluded.updated",
    ).bind(s.ip, t),
  ]);
}

// Public shape of a standing, for the UI.
export const describe = (s) => ({
  tier: s.tier,
  used: s.used,
  limit: s.limit,
  remaining: s.remaining,
  requested: s.status === "pending",
  device: s.pass?.dev || null,
  passInvalid: s.passInvalid,
});

export const REQUEST_LIMITS = { name: 60, note: 500 };

// Marks the visitor as asking for access. Approved/denied visitors keep their status.
// -> true when this is a new request (not an edit of a pending one), i.e. worth an alert.
export async function requestAccess(env, s, { name, note }) {
  const t = now();
  const prev = await env.DB.prepare("SELECT status FROM visitors WHERE id = ?").bind(s.visitor).first();
  await env.DB.prepare(
    "INSERT INTO visitors (id, ip, prompts, status, name, note, created, updated, requested) VALUES (?, ?, 0, 'pending', ?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET status = CASE WHEN status IN ('approved','denied') THEN status ELSE 'pending' END, " +
      "name = excluded.name, note = excluded.note, ip = excluded.ip, updated = excluded.updated, requested = excluded.requested",
  ).bind(s.visitor, s.ip, name, note, t, t, t).run();
  return !prev || prev.status === "free";
}

export async function listVisitors(env) {
  await ensureSchema(env.DB);
  const { results } = await env.DB.prepare(
    "SELECT id, ip, prompts, status, name, note, created, updated, requested FROM visitors " +
      "ORDER BY CASE status WHEN 'pending' THEN 0 ELSE 1 END, COALESCE(requested, updated) DESC LIMIT 200",
  ).all();
  return results ?? [];
}

// action: approve | deny | reset. -> true if the visitor existed.
export async function decide(env, id, action) {
  await ensureSchema(env.DB);
  const t = now();
  if (action === "reset") {
    const v = await env.DB.prepare("SELECT ip FROM visitors WHERE id = ?").bind(id).first();
    if (!v) return false;
    await env.DB.batch([
      env.DB.prepare("UPDATE visitors SET prompts = 0, status = 'free', updated = ? WHERE id = ?").bind(t, id),
      env.DB.prepare("UPDATE ips SET prompts = 0, updated = ? WHERE ip = ?").bind(t, v.ip),
    ]);
    return true;
  }
  const status = action === "approve" ? "approved" : "denied";
  const r = await env.DB.prepare("UPDATE visitors SET status = ?, updated = ? WHERE id = ?").bind(status, t, id).run();
  return (r.meta?.changes ?? 0) > 0;
}
