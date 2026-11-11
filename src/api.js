// App logic lives here. Each handler: (request, env, ctx, url) -> Response.
// Return JSON via json(); errors are caught and logged by src/index.js.
//
// The Worker is a narrow proxy to the owner's Ollama-compatible servers, each reached
// through a Cloudflare Tunnel that only admits the Access service token held in
// OLLAMA_CLIENT_ID / OLLAMA_CLIENT_SECRET:
//   desktop  env.OLLAMA_URL  Ollama on the office desktop (RTX 4060)
//   hailo    env.HAILO_URL   hailo-ollama on the Pi's Hailo-10H AI HAT
// Desktop model ids are the plain Ollama names; Pi model ids are "hailo/<name>".
// Only /api/tags (+ /api/show) and /api/chat are ever called upstream, so
// pull/delete/create stay private.

import { verifyAccess } from "./access.js";

export const json = (data, init = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init.headers },
  });

export const LIMITS = { bodyBytes: 512 * 1024, messages: 400, contentChars: 100_000, models: 25 };
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const ROLES = new Set(["system", "user", "assistant"]);

// Prepended when a conversation has no system message. Without it deepseek-r1
// answers short prompts ("hi") in Chinese, reasoning included. Override with the
// SYSTEM_PROMPT var.
export const DEFAULT_SYSTEM =
  "You are a helpful assistant. Always think and respond in English, unless the user explicitly writes in or asks for another language.";

// Wraps a handler so it only runs for a verified Access user.
const gated = (handler) => async (request, env, ctx, url) => {
  const who = await verifyAccess(request, env, env.__fetch ?? fetch);
  if (!who.ok) return json({ error: who.error }, { status: who.status });
  return handler(request, env, ctx, url, who);
};

export const BACKENDS = {
  desktop: { urlVar: "OLLAMA_URL", prefix: "", show: true },
  hailo: { urlVar: "HAILO_URL", prefix: "hailo/", show: false }, // hailo-ollama has no capabilities in /api/show
};

// Maps a public model id to {backend, name}. Unprefixed ids belong to the desktop.
export function route(id) {
  for (const [backend, b] of Object.entries(BACKENDS)) {
    if (b.prefix && id.startsWith(b.prefix)) return { backend, name: id.slice(b.prefix.length) };
  }
  return { backend: "desktop", name: id };
}

const configured = (env, backend) => !!(env[BACKENDS[backend].urlVar] || "").trim();

function ollama(env, backend, path, init = {}) {
  const base = (env[BACKENDS[backend].urlVar] || "").trim();
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
// Describes an upstream failure as {status, body} so the UI can explain it.
async function upstreamFailure(res, backend) {
  if (!res) return { status: 503, body: { error: "not_configured", backend } };
  if (res.status >= 300 && res.status < 400) return { status: 502, body: { error: "tunnel_auth", backend } };
  // 502/503/504/530 from Cloudflare: tunnel up but origin down, or tunnel down.
  if ([502, 503, 504, 530].includes(res.status)) return { status: 503, body: { error: "offline", backend } };
  let detail = "";
  try {
    const body = await res.text();
    detail = (JSON.parse(body).error ?? body).toString().slice(0, 300);
  } catch {}
  return { status: 502, body: { error: "upstream", backend, status: res.status, detail } };
}

const upstreamError = async (res, backend) => {
  const f = await upstreamFailure(res, backend);
  return json(f.body, { status: f.status });
};

async function call(env, backend, path, init) {
  try {
    const res = ollama(env, backend, path, init);
    return res ? await res : null;
  } catch (err) {
    console.error(JSON.stringify({ upstream: path, backend, error: String(err?.message || err) }));
    return { ok: false, status: 503, text: async () => "" };
  }
}

// One backend's models, or {failure} when it can't be listed.
async function listBackend(env, backend) {
  const b = BACKENDS[backend];
  const tags = await call(env, backend, "/api/tags", { method: "GET" });
  if (!tags?.ok) return { failure: await upstreamFailure(tags, backend) };
  const list = ((await tags.json()).models ?? []).slice(0, LIMITS.models);
  const models = await Promise.all(
    list.map(async (m) => {
      let capabilities = [];
      if (b.show) {
        const show = await call(env, backend, "/api/show", { method: "POST", body: JSON.stringify({ model: m.name }) });
        if (show?.ok) capabilities = (await show.json()).capabilities ?? [];
      }
      return {
        name: b.prefix + m.name,
        backend,
        size: m.size ?? null,
        parameters: m.details?.parameter_size ?? null,
        family: m.details?.family ?? null,
        thinking: capabilities.includes("thinking"),
      };
    }),
  );
  return { models };
}

// Lists every configured backend. One being offline doesn't hide the others; the
// request only fails when none can be listed.
async function models(request, env) {
  const names = Object.keys(BACKENDS).filter((k) => k === "desktop" || configured(env, k));
  const results = await Promise.all(names.map((k) => listBackend(env, k)));
  const backends = {};
  const out = [];
  names.forEach((k, i) => {
    const r = results[i];
    backends[k] = r.failure ? r.failure.body.error : "online";
    if (r.models) out.push(...r.models);
  });
  if (results.every((r) => r.failure)) {
    const f = results[0].failure;
    return json({ ...f.body, backends }, { status: f.status });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return json({ models: out, backends });
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

  const messages = v.messages.some((m) => m.role === "system")
    ? v.messages
    : [{ role: "system", content: (env.SYSTEM_PROMPT || "").trim() || DEFAULT_SYSTEM }, ...v.messages];
  const { backend, name } = route(v.model);
  if (!name) return json({ error: "bad_request", detail: "invalid model" }, { status: 400 });
  const payload = { model: name, messages, stream: true };
  if (v.think && BACKENDS[backend].show) payload.think = true;
  const res = await call(env, backend, "/api/chat", { method: "POST", body: JSON.stringify(payload), signal: request.signal });
  if (!res?.ok) return upstreamError(res, backend);

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
