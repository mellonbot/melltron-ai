// App logic lives here. Each handler: (request, env, ctx, url) -> Response.
// Return JSON via json(); errors are caught and logged by src/index.js.
//
// The Worker is a narrow proxy to the owner's model servers, each reached through a
// Cloudflare Tunnel that only admits the Access service token held in
// OLLAMA_CLIENT_ID / OLLAMA_CLIENT_SECRET:
//   desktop  env.OLLAMA_URL   Ollama on the office desktop (RTX 4060); empty = off
//   localai  env.LOCALAI_URL  LocalAI on the office desktop (RTX 4060); empty = off
//   pi       env.PI_URL       Ollama on the Pi (CPU); empty = off
// Desktop Ollama ids are the plain names; LocalAI ids are "rtx/<name>", Pi ids "pi/<name>".
// Ollama-style servers only ever see /api/tags (+ /api/show) and /api/chat; LocalAI
// (OpenAI API) only /v1/models and /v1/chat/completions, translated to the same
// shapes, so the UI sees one protocol and model management stays private.

import { verifyAccess } from "./access.js";
import { notifyOwner } from "./alert.js";
import { standing, canChat, consume, describe, requestAccess, listVisitors, decide, freePrompts, verifyPass, VISITOR, REQUEST_LIMITS } from "./quota.js";
import { repoQa } from "./repo-qa.js";

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

// PUBLIC="true" opens the app with no Access login. The tunnels stay locked to
// the service token. CHAT_ACCESS chooses who may then use the models:
//   tailnet  (default) a valid tailnet pass is required for models and chat.
//            The pass is the only tailnet proof available here — tailnet-pass.py
//            mints it after `tailscale whois`, and Cloudflare does not show the
//            Tailscale address. Anything other than "public" means tailnet.
//   public   the previous policy: FREE_PROMPTS, then the owner's approval
//            (src/quota.js). Tailnet passes stay unlimited.
// The flag is ignored when PUBLIC is not "true"; private mode still requires
// Access. Per-IP rate limits are a coarse extra brake. Public mode fails closed
// without those bindings. The free-prompt policy also fails closed without D1;
// a tailnet pass does not need D1.
export const TAILNET_ONLY_MESSAGE =
  "This chat is currently limited to the private network. From a device on that network, open the tailnet pass page and it will send you back here.";
export const TAILNET_PASS_MESSAGE =
  "This chat is limited to the private network, and the pass saved in this browser is no longer valid. Open the tailnet pass page again from a device on that network.";

const isPublic = (env) => (env.PUBLIC || "").trim() === "true";
export const chatAccessMode = (env) => ((env.CHAT_ACCESS || "").trim() === "public" ? "public" : "tailnet");
const tailnetOnly = (env) => isPublic(env) && chatAccessMode(env) === "tailnet";

const closedQuota = (passInvalid) => ({
  tier: "closed",
  used: 0,
  limit: 0,
  remaining: 0,
  requested: false,
  device: null,
  passInvalid,
  message: passInvalid ? TAILNET_PASS_MESSAGE : TAILNET_ONLY_MESSAGE,
});

// null when the request may continue. A 403 when tailnet-only and the pass is
// missing or bad — before rate limits, D1, or the model servers.
async function denyUnlessTailnet(request, env) {
  if (!tailnetOnly(env)) return null;
  const token = request.headers.get("x-ai-pass");
  if (await verifyPass(token, env.PASS_SECRET)) return null;
  const quota = closedQuota(!!token);
  return json({ error: "tailnet_only", message: quota.message, quota }, { status: 403 });
}

// Wraps a handler so it only runs for a verified Access user (or anyone, when
// public) who is within the rate limit named by `limiter`. opts.tailnet applies
// the pass check first, and only while CHAT_ACCESS is tailnet.
const gated = (handler, limiter, opts = {}) => async (request, env, ctx, url) => {
  let who = { ok: true, email: null };
  if (!isPublic(env)) {
    who = await verifyAccess(request, env, env.__fetch ?? fetch);
    if (!who.ok) return json({ error: who.error }, { status: who.status });
  } else if (opts.tailnet) {
    const denied = await denyUnlessTailnet(request, env);
    if (denied) return denied;
  }
  if (limiter) {
    const rl = env[limiter];
    if (!rl) {
      if (isPublic(env)) return json({ error: "rate_limit_not_configured" }, { status: 503 });
    } else {
      const key = request.headers.get("cf-connecting-ip") || "unknown";
      const { success } = await rl.limit({ key });
      if (!success) return json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
    }
  }
  return handler(request, env, ctx, url, who);
};

export const BACKENDS = {
  desktop: { urlVar: "OLLAMA_URL", prefix: "", show: true },
  localai: { urlVar: "LOCALAI_URL", prefix: "rtx/", show: false, openai: true },
  pi: { urlVar: "PI_URL", prefix: "pi/", show: true },
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
  const headers = {
    "content-type": "application/json",
    "CF-Access-Client-Id": env.OLLAMA_CLIENT_ID,
    "CF-Access-Client-Secret": env.OLLAMA_CLIENT_SECRET,
  };
  // Optional second lock: LocalAI's own API key (its API_KEY setting).
  const key = BACKENDS[backend].openai && (env.LOCALAI_API_KEY || "").trim();
  if (key) headers.authorization = `Bearer ${key}`;
  return f(new URL(path, base), {
    ...init,
    redirect: "manual", // a 302 here means Access refused the service token
    headers,
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
    let e = body;
    try { e = JSON.parse(body).error ?? body; } catch {}
    detail = (typeof e === "object" && e ? e.message ?? JSON.stringify(e) : e).toString().slice(0, 300);
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

// Optional comma-separated allowlist. Empty means every model the backend lists.
// LocalAI's /v1/models also lists embedding, TTS and image models, which can't chat.
const allowedSet = (env, key) => {
  const list = (env[key] || "").split(",").map((s) => s.trim()).filter(Boolean);
  return list.length ? new Set(list) : null;
};
const localaiAllowed = (env) => allowedSet(env, "LOCALAI_MODELS");
const ollamaAllowed = (env) => allowedSet(env, "OLLAMA_MODELS");

async function listOpenAI(env, backend) {
  const b = BACKENDS[backend];
  const res = await call(env, backend, "/v1/models", { method: "GET" });
  if (!res?.ok) return { failure: await upstreamFailure(res, backend) };
  const allow = localaiAllowed(env);
  const ids = ((await res.json()).data ?? [])
    .map((m) => m?.id)
    .filter((id) => typeof id === "string" && MODEL.test(b.prefix + id) && (!allow || allow.has(id)));
  return {
    models: ids.slice(0, LIMITS.models).map((id) => ({
      name: b.prefix + id, backend, size: null, parameters: null, family: null, thinking: false,
    })),
  };
}

// One backend's models, or {failure} when it can't be listed.
async function listBackend(env, backend) {
  const b = BACKENDS[backend];
  if (b.openai) return listOpenAI(env, backend);
  const tags = await call(env, backend, "/api/tags", { method: "GET" });
  if (!tags?.ok) return { failure: await upstreamFailure(tags, backend) };
  const allow = backend === "desktop" ? ollamaAllowed(env) : null;
  const list = ((await tags.json()).models ?? [])
    .filter((m) => !allow || allow.has(m.name))
    .slice(0, LIMITS.models);
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
// request only fails when none can be listed. With nothing configured, the desktop
// is still tried so the UI gets not_configured instead of an empty list.
async function models(request, env) {
  const denied = await denyUnlessTailnet(request, env);
  if (denied) return denied;
  const on = Object.keys(BACKENDS).filter((k) => configured(env, k));
  const names = on.length ? on : ["desktop"];
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

  let quota = null;
  if (isPublic(env)) {
    if (tailnetOnly(env)) {
      const denied = await denyUnlessTailnet(request, env);
      if (denied) return denied;
      // A valid pass never reads or writes D1.
      quota = await standing(request, env);
    } else {
      if (!env.DB) return json({ error: "quota_not_configured" }, { status: 503 });
      quota = await standing(request, env);
      if (quota.tier === "invalid") return json({ error: "visitor_required" }, { status: 400 });
      if (!canChat(quota)) {
        return json({ error: quota.tier === "denied" ? "denied" : "quota_exhausted", quota: describe(quota) }, { status: 403 });
      }
    }
  }

  const b = BACKENDS[backend];
  const allow = b.openai ? localaiAllowed(env) : (backend === "desktop" ? ollamaAllowed(env) : null);
  if (allow && !allow.has(name)) return json({ error: "bad_request", detail: "invalid model" }, { status: 400 });
  const payload = { model: name, messages, stream: true };
  if (v.think && b.show) payload.think = true;
  const res = await call(env, backend, b.openai ? "/v1/chat/completions" : "/api/chat", { method: "POST", body: JSON.stringify(payload), signal: request.signal });
  if (!res?.ok) return upstreamError(res, backend);
  // Only prompts the model actually started answering count.
  if (quota) await consume(env, quota);

  // Ollama streams NDJSON; pass it straight through. OpenAI SSE is translated to it.
  return new Response(b.openai ? res.body.pipeThrough(sseToNdjson()) : res.body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" },
  });
}

// OpenAI chat-completions SSE -> Ollama /api/chat NDJSON, so the UI parses one format.
//   data: {"choices":[{"delta":{"content":"Hi"}}]}  ->  {"message":{"role":"assistant","content":"Hi"},"done":false}
//   data: [DONE]                                   ->  {"done":true}
// delta.reasoning_content / delta.reasoning become message.thinking; an error event
// becomes {"error": "..."}. A stream that ends without [DONE] still gets a final done.
export function sseToNdjson() {
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let buf = "";
  let finished = false;
  const emit = (ctl, obj) => ctl.enqueue(enc.encode(JSON.stringify(obj) + "\n"));
  const line = (ctl, raw) => {
    const l = raw.trim();
    if (finished || !l.startsWith("data:")) return; // comments, event:, id:, blank lines
    const data = l.slice(5).trim();
    if (data === "[DONE]") { finished = true; emit(ctl, { done: true }); return; }
    let evt;
    try { evt = JSON.parse(data); } catch { return; }
    if (evt.error) {
      finished = true;
      const e = evt.error;
      emit(ctl, { error: String((typeof e === "object" ? e.message : e) || "upstream error").slice(0, 300), done: true });
      return;
    }
    const d = evt.choices?.[0]?.delta ?? {};
    const thinking = d.reasoning_content ?? d.reasoning;
    if (!d.content && !thinking) return;
    const message = { role: "assistant", content: d.content || "" };
    if (thinking) message.thinking = thinking;
    emit(ctl, { message, done: false });
  };
  return new TransformStream({
    transform(chunk, ctl) {
      buf += dec.decode(chunk, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) { line(ctl, buf.slice(0, nl)); buf = buf.slice(nl + 1); }
    },
    flush(ctl) {
      buf += dec.decode();
      if (buf) line(ctl, buf);
      if (!finished) emit(ctl, { done: true });
    },
  });
}

// What the caller may do: tailnet / approved / free (+remaining) / pending / exhausted / denied.
async function quotaRoute(request, env) {
  if (!isPublic(env)) return json({ tier: "private" });
  if (tailnetOnly(env)) {
    const token = request.headers.get("x-ai-pass");
    if (!(await verifyPass(token, env.PASS_SECRET))) return json(closedQuota(!!token));
    return json(describe(await standing(request, env)));
  }
  if (!env.DB) return json({ error: "quota_not_configured" }, { status: 503 });
  const s = await standing(request, env);
  if (s.tier === "invalid") return json({ error: "visitor_required" }, { status: 400 });
  return json(describe(s));
}

async function readSmallJson(request, max = 4096) {
  const raw = await request.text();
  if (raw.length > max) return null;
  try {
    const b = JSON.parse(raw);
    return b && typeof b === "object" && !Array.isArray(b) ? b : null;
  } catch {
    return null;
  }
}

const cleanText = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

// A visitor out of free prompts asks the owner for more.
async function accessRequest(request, env, ctx, url) {
  if (!isPublic(env)) return json({ error: "not_found" }, { status: 404 });
  // Off while tailnet-only. An approval would let that browser chat from
  // anywhere, which is the hole this mode closes. /admin still stores decisions
  // for when CHAT_ACCESS is set back to public; nothing is emailed or written here.
  if (tailnetOnly(env)) return json({ error: "tailnet_only", message: TAILNET_ONLY_MESSAGE }, { status: 403 });
  if (!env.DB) return json({ error: "quota_not_configured" }, { status: 503 });
  const s = await standing(request, env);
  if (s.tier === "invalid") return json({ error: "visitor_required" }, { status: 400 });
  if (s.tier === "tailnet") return json(describe(s));
  const body = await readSmallJson(request);
  if (!body) return json({ error: "bad_request", detail: "invalid JSON" }, { status: 400 });
  const name = cleanText(body.name, REQUEST_LIMITS.name);
  const note = cleanText(body.note, REQUEST_LIMITS.note);
  if (!name) return json({ error: "bad_request", detail: "name is required" }, { status: 400 });
  const fresh = await requestAccess(env, s, { name, note });
  if (fresh) {
    const alert = notifyOwner(env, { name, note, ip: s.ip, prompts: s.used, adminUrl: new URL("/admin/", url).href });
    // Don't make the visitor wait for the email.
    if (ctx?.waitUntil) ctx.waitUntil(alert);
    else await alert;
  }
  return json(describe(await standing(request, env)));
}

// /api/admin/* sits behind its own Access app (owner only). Re-verify its JWT here
// too, since preview URLs skip Access.
const admin = (handler) => async (request, env, ctx, url) => {
  const aud = (env.ADMIN_ACCESS_AUD || "").trim();
  const who = await verifyAccess(request, { ...env, ACCESS_AUD: aud }, env.__fetch ?? fetch);
  if (!who.ok) return json({ error: who.error }, { status: who.status });
  if (!env.DB) return json({ error: "quota_not_configured" }, { status: 503 });
  return handler(request, env, ctx, url, who);
};

// Only explicitly configured Q&A and Mellonpanel audiences grant repo access.
const protectedRepoQa = async (request, env) => {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "forbidden_origin" }, { status: 403 });
  const audiences = [env.REPO_QA_ACCESS_AUD, env.MELLONPANEL_ACCESS_AUD].map((aud) => (aud || "").trim()).filter(Boolean);
  const unrelated = [env.ACCESS_AUD, env.ADMIN_ACCESS_AUD].map((aud) => (aud || "").trim()).filter(Boolean);
  if (audiences.some((aud) => unrelated.includes(aud))) return json({ error: "access_not_configured" }, { status: 503 });
  const who = await verifyAccess(request, env, env.__fetch ?? fetch, audiences);
  if (!who.ok) return json({ error: who.error }, { status: who.status });
  if (!who.human || typeof who.email !== "string" || !who.email.trim()) return json({ error: "unauthenticated" }, { status: 401 });
  if (!env.CHAT_LIMIT) return json({ error: "rate_limit_not_configured" }, { status: 503 });
  // Keyed by identity: every Mellonpanel request arrives from the panel host's IP.
  const { success } = await env.CHAT_LIMIT.limit({ key: `repo-qa:${who.email.trim().toLowerCase()}` });
  if (!success) return json({ error: "rate_limited" }, { status: 429, headers: { "retry-after": "60" } });
  return repoQa(request, env, { json, call });
};

const ACTIONS = new Set(["approve", "deny", "reset"]);

export const routes = {
  "GET /api/ping": () => json({ ok: true, at: new Date().toISOString() }),
  "GET /api/me": gated((req, env, ctx, url, who) => json({ email: who.email, public: isPublic(env) })),
  "GET /api/models": gated(models, "MODELS_LIMIT", { tailnet: true }),
  "POST /api/chat": gated(chat, "CHAT_LIMIT", { tailnet: true }),
  "POST /api/repo-qa": protectedRepoQa,
  "GET /api/quota": gated(quotaRoute, "MODELS_LIMIT"),
  "POST /api/access-request": gated(accessRequest, "MODELS_LIMIT"),
  "GET /api/admin/visitors": admin(async (req, env, ctx, url, who) =>
    json({ visitors: await listVisitors(env), freePrompts: freePrompts(env), chatAccess: chatAccessMode(env), admin: who.email })),
  "POST /api/admin/visitors": admin(async (req, env) => {
    const body = await readSmallJson(req);
    if (!body || typeof body.id !== "string" || !VISITOR.test(body.id) || !ACTIONS.has(body.action)) {
      return json({ error: "bad_request", detail: "need {id, action: approve|deny|reset}" }, { status: 400 });
    }
    const found = await decide(env, body.id, body.action);
    return found ? json({ ok: true }) : json({ error: "not_found" }, { status: 404 });
  }),
};
