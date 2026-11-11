// App logic lives here. Each handler: (request, env, ctx, url) -> Response.
// Return JSON via json(); errors are caught and logged by src/index.js.
//
// The Worker is a narrow proxy to the owner's Ollama, reached through a Cloudflare
// Tunnel (env.OLLAMA_URL) that only admits the Access service token held in
// OLLAMA_CLIENT_ID / OLLAMA_CLIENT_SECRET. Only two Ollama endpoints are ever
// called — /api/tags (+ /api/show) and /api/chat — so pull/delete/create stay private.

import { verifyAccess } from "./access.js";

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init.headers },
  });

export const LIMITS = { bodyBytes: 512 * 1024, messages: 400, contentChars: 100_000, models: 25 };
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const ROLES = new Set(["system", "user", "assistant"]);

// Wraps a handler so it only runs for a verified Access user.
const gated = (handler) => async (request, env, ctx, url) => {
  const who = await verifyAccess(request, env, env.__fetch ?? fetch);
  if (!who.ok) return json({ error: who.error }, { status: who.status });
  return handler(request, env, ctx, url, who);
};

function ollama(env, path, init = {}) {
  const base = (env.OLLAMA_URL || "").trim();
  if (!base || !env.OLLAMA_CLIENT_ID || !env.OLLAMA_CLIENT_SECRET) return null;
  const f = env.__fetch ?? fetch;
  return f(new URL(path, base), {
    ...init,
    redirect: "manual", // a 302 here means Access refused the service token
    headers: {
      "content-type": "application/json",
      "CF-Access-Client-Id": env.OLLAMA_CLIENT_ID,
      "CF-Access-Client-Secret": env.OLLAMA_CLIENT_SECRET,
    },
  });
}

// Maps an upstream failure to something the UI can explain.
async function upstreamError(res) {
  if (!res) return json({ error: "not_configured" }, { status: 503 });
  if (res.status >= 300 && res.status < 400) return json({ error: "tunnel_auth" }, { status: 502 });
  // 502/503/504/530 from Cloudflare: tunnel up but origin down, or tunnel down.
  if ([502, 503, 504, 530].includes(res.status)) return json({ error: "offline" }, { status: 503 });
  let detail = "";
  try {
    const body = await res.text();
    detail = (JSON.parse(body).error ?? body).toString().slice(0, 300);
  } catch {}
  return json({ error: "upstream", status: res.status, detail }, { status: 502 });
}

async function call(env, path, init) {
  try {
    const res = ollama(env, path, init);
    return res ? await res : null;
  } catch (err) {
    console.error(JSON.stringify({ upstream: path, error: String(err?.message || err) }));
    return { ok: false, status: 503, text: async () => "" };
  }
}

async function models(request, env) {
  const tags = await call(env, "/api/tags", { method: "GET" });
  if (!tags?.ok) return upstreamError(tags);
  const list = ((await tags.json()).models ?? []).slice(0, LIMITS.models);
  const out = await Promise.all(
    list.map(async (m) => {
      let capabilities = [];
      const show = await call(env, "/api/show", { method: "POST", body: JSON.stringify({ model: m.name }) });
      if (show?.ok) capabilities = (await show.json()).capabilities ?? [];
      return {
        name: m.name,
        size: m.size ?? null,
        parameters: m.details?.parameter_size ?? null,
        family: m.details?.family ?? null,
        thinking: capabilities.includes("thinking"),
      };
    }),
  );
  out.sort((a, b) => a.name.localeCompare(b.name));
  return json({ models: out });
}

// Returns a clean {model, messages, think} or a string describing what's wrong.
export function validateChat(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  const { model, messages, think } = body;
  if (typeof model !== "string" || !MODEL.test(model)) return "invalid model";
  if (!Array.isArray(messages) || messages.length === 0) return "messages must be a non-empty array";
  if (messages.length > LIMITS.messages) return `at most ${LIMITS.messages} messages`;
  const clean = [];
  for (const m of messages) {
    if (!m || !ROLES.has(m.role) || typeof m.content !== "string") return "each message needs a role and string content";
    if (m.content.length > LIMITS.contentChars) return `message longer than ${LIMITS.contentChars} characters`;
    clean.push({ role: m.role, content: m.content });
  }
  if (clean.at(-1).role !== "user") return "last message must be from the user";
  return { model, messages: clean, think: think === true };
}

async function chat(request, env) {
  const len = Number(request.headers.get("content-length") || 0);
  if (len > LIMITS.bodyBytes) return json({ error: "too_large" }, { status: 413 });
  const raw = await request.text();
  if (raw.length > LIMITS.bodyBytes) return json({ error: "too_large" }, { status: 413 });

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json({ error: "bad_request", detail: "invalid JSON" }, { status: 400 });
  }
  const v = validateChat(body);
  if (typeof v === "string") return json({ error: "bad_request", detail: v }, { status: 400 });

  const payload = { model: v.model, messages: v.messages, stream: true };
  if (v.think) payload.think = true;
  const res = await call(env, "/api/chat", { method: "POST", body: JSON.stringify(payload), signal: request.signal });
  if (!res?.ok) return upstreamError(res);

  // Ollama streams NDJSON; pass it straight through.
  return new Response(res.body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

export const routes = {
  "GET /api/ping": () => json({ ok: true, at: new Date().toISOString() }),
  "GET /api/me": gated((req, env, ctx, url, who) => json({ email: who.email })),
  "GET /api/models": gated(models),
  "POST /api/chat": gated(chat),
};
