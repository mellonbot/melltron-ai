// API: Access gating, Ollama proxying, validation and error mapping.
// Ollama and the Access certs endpoint are faked through env.__fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { _resetAccessCache } from "../src/access.js";
import { validateChat, LIMITS, DEFAULT_SYSTEM, sseToNdjson } from "../src/api.js";
import { _resetSchema } from "../src/quota.js";
import { fakeD1 } from "./d1.js";

const TEAM = "lab.cloudflareaccess.com";
const AUD = "aud-123";

// --- a real RS256 keypair so signature checks are exercised, not stubbed ---
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function token(claims = {}, kid = "k1", key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
  const p = b64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: "me@example.com", exp: now + 600, iat: now, ...claims }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

// --- fake upstreams ---
let calls;
let ollama; // (path, init) -> Response
const fakeFetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.host === TEAM && url.pathname === "/cdn-cgi/access/certs") return Response.json({ keys: [jwk] });
  calls.push({ path: url.pathname, init });
  return ollama(url.pathname, init);
};
const env = {
  ASSETS: { fetch: async () => new Response("x", { headers: { "content-type": "text/html" } }) },
  ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD,
  OLLAMA_URL: "https://ollama-tunnel.example", OLLAMA_CLIENT_ID: "cid", OLLAMA_CLIENT_SECRET: "csecret",
  __fetch: fakeFetch,
};
const req = async (path, { method = "GET", body, jwt, e = env } = {}) => {
  const headers = { "content-type": "application/json" };
  if (jwt !== null) headers["cf-access-jwt-assertion"] = jwt ?? (await token());
  return worker.fetch(new Request(`https://ai.melltron.build${path}`, { method, headers, body: body && JSON.stringify(body) }), e, {});
};
const quiet = async (fn) => { const w = console.warn, er = console.error; console.warn = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = er; } };

const chatBody = { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] };

beforeEach(() => {
  _resetAccessCache();
  _resetSchema();
  calls = [];
  ollama = (path) => {
    if (path === "/api/tags") return Response.json({ models: [
      { name: "llama3.1:8b", size: 1, details: { parameter_size: "8.0B", family: "llama" } },
      { name: "deepseek-r1:8b", size: 2, details: { parameter_size: "8.2B", family: "qwen3" } },
    ] });
    if (path === "/api/show") return Response.json({ capabilities: ["completion"] });
    if (path === "/api/chat") return new Response('{"message":{"content":"he"}}\n{"message":{"content":"llo"},"done":true}\n');
    return new Response("nope", { status: 404 });
  };
});

// ---------- Access gate ----------
test("API routes fail closed without Access config", async () => {
  for (const p of ["/api/me", "/api/models"]) {
    const res = await req(p, { e: { ...env, ACCESS_AUD: "" } });
    assert.equal(res.status, 503, p);
    assert.equal((await res.json()).error, "access_not_configured");
  }
  assert.equal(calls.length, 0, "never reaches Ollama");
});

test("missing, forged, expired and wrong-audience tokens are rejected", async () => {
  const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign"]);
  const bad = [
    null,
    "not.a.jwt",
    await token({}, "k1", other.privateKey),
    await token({ exp: Math.floor(Date.now() / 1000) - 5 }),
    await token({ aud: ["someone-else"] }),
    await token({ iss: "https://evil.cloudflareaccess.com" }),
    await token({}, "unknown-kid"),
  ];
  for (const jwt of bad) {
    const res = await quiet(() => req("/api/models", { jwt }));
    assert.equal(res.status, 401, String(jwt).slice(0, 20));
  }
  const chat = await quiet(() => req("/api/chat", { method: "POST", body: chatBody, jwt: null }));
  assert.equal(chat.status, 401);
  assert.equal(calls.length, 0, "never reaches Ollama");
});

test("/api/me returns the verified email", async () => {
  const res = await req("/api/me");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { email: "me@example.com", public: false });
});

test("/_health and /api/ping stay public", async () => {
  assert.equal((await req("/_health", { jwt: null })).status, 200);
  assert.equal((await req("/api/ping", { jwt: null })).status, 200);
});

// ---------- models ----------
test("/api/models lists models, sorted, with thinking capability, using the service token", async () => {
  ollama = ((orig) => (path, init) => {
    if (path === "/api/show") return Response.json({ capabilities: JSON.parse(init.body).model.startsWith("deepseek") ? ["thinking", "completion"] : ["completion"] });
    return orig(path, init);
  })(ollama);
  const res = await req("/api/models");
  assert.equal(res.status, 200);
  const { models } = await res.json();
  assert.deepEqual(models.map((m) => [m.name, m.thinking, m.parameters]), [["deepseek-r1:8b", true, "8.2B"], ["llama3.1:8b", false, "8.0B"]]);
  for (const c of calls) {
    assert.equal(c.init.headers["CF-Access-Client-Id"], "cid");
    assert.equal(c.init.headers["CF-Access-Client-Secret"], "csecret");
    assert.equal(c.init.redirect, "manual");
  }
});

// ---------- chat ----------
test("/api/chat streams NDJSON through and only forwards clean fields", async () => {
  const res = await req("/api/chat", { method: "POST", body: { ...chatBody, messages: [{ role: "user", content: "hi", extra: "x", images: ["…"] }], think: true, options: { num_ctx: 999999 }, keep_alive: -1 } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(res.headers.get("Content-Security-Policy"));
  assert.match(await res.text(), /"llo"/);
  const sent = JSON.parse(calls.find((c) => c.path === "/api/chat").init.body);
  assert.deepEqual(sent, { model: "llama3.1:8b", messages: [{ role: "system", content: DEFAULT_SYSTEM }, { role: "user", content: "hi" }], stream: true, think: true });
});

test("only tags/show/chat are ever proxied", async () => {
  for (const p of ["/api/pull", "/api/delete", "/api/create", "/api/generate"]) {
    assert.equal((await req(p, { method: "POST", body: {} })).status, 404, p);
  }
  assert.equal(calls.length, 0);
});

test("chat validation", () => {
  assert.equal(typeof validateChat(chatBody), "object");
  const bad = [
    null, [], {},
    { ...chatBody, model: "../etc" }, { ...chatBody, model: "" },
    { ...chatBody, messages: [] },
    { ...chatBody, messages: [{ role: "tool", content: "x" }] },
    { ...chatBody, messages: [{ role: "user", content: 1 }] },
    { ...chatBody, messages: [{ role: "assistant", content: "last must be user" }] },
    { ...chatBody, messages: Array(LIMITS.messages + 1).fill({ role: "user", content: "x" }) },
    { ...chatBody, messages: [{ role: "user", content: "x".repeat(LIMITS.contentChars + 1) }] },
  ];
  for (const b of bad) assert.equal(typeof validateChat(b), "string", JSON.stringify(b)?.slice(0, 60));
});

test("bad JSON and oversized bodies are rejected before Ollama", async () => {
  const jwt = await token();
  const raw = (body) => worker.fetch(new Request("https://ai.melltron.build/api/chat", { method: "POST", headers: { "cf-access-jwt-assertion": jwt }, body }), env, {});
  assert.equal((await raw("{nope")).status, 400);
  assert.equal((await raw("x".repeat(LIMITS.bodyBytes + 1))).status, 413);
  assert.equal(calls.length, 0);
});

// ---------- upstream failures ----------
test("upstream failures map to explainable errors", async () => {
  const cases = [
    [() => new Response("", { status: 530 }), 503, "offline"],
    [() => new Response("", { status: 502 }), 503, "offline"],
    [() => { throw new TypeError("connect failed"); }, 503, "offline"],
    [() => new Response(null, { status: 302, headers: { location: "https://lab.cloudflareaccess.com/login" } }), 502, "tunnel_auth"],
    [() => Response.json({ error: "model 'x' not found" }, { status: 404 }), 502, "upstream"],
  ];
  for (const [impl, status, error] of cases) {
    ollama = impl;
    const res = await quiet(() => req("/api/chat", { method: "POST", body: chatBody }));
    assert.equal(res.status, status, error);
    const body = await res.json();
    assert.equal(body.error, error);
    if (error === "upstream") assert.match(body.detail, /not found/);
  }
});

test("missing tunnel config is reported, not attempted", async () => {
  const res = await req("/api/models", { e: { ...env, OLLAMA_CLIENT_SECRET: "" } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "not_configured");
  assert.equal(calls.length, 0);
});

test("default English system prompt: added when absent, configurable, never duplicated", async () => {
  const sentMessages = () => JSON.parse(calls.findLast((c) => c.path === "/api/chat").init.body).messages;
  await req("/api/chat", { method: "POST", body: chatBody });
  assert.equal(sentMessages()[0].content, DEFAULT_SYSTEM);
  await req("/api/chat", { method: "POST", body: chatBody, e: { ...env, SYSTEM_PROMPT: "Be terse." } });
  assert.deepEqual(sentMessages()[0], { role: "system", content: "Be terse." });
  const own = { ...chatBody, messages: [{ role: "system", content: "Pirate voice." }, ...chatBody.messages] };
  await req("/api/chat", { method: "POST", body: own });
  assert.deepEqual(sentMessages().filter((m) => m.role === "system"), [{ role: "system", content: "Pirate voice." }]);
});

// ---------- second backend: hailo-ollama on the Pi ----------
const hailoEnv = { ...env, HAILO_URL: "https://hailo-tunnel.example" };
// Routes fake upstream calls by host so each backend can be up or down on its own.
const byHost = (desktop, hailo) => async (input, init = {}) => {
  const url = new URL(input);
  if (url.host === TEAM) return fakeFetch(input, init);
  calls.push({ host: url.host, path: url.pathname, init });
  return (url.host === "hailo-tunnel.example" ? hailo : desktop)(url.pathname, init);
};
const hailoUp = (path) => {
  if (path === "/api/tags") return Response.json({ models: [{ name: "qwen2:1.5b", size: 3, details: { parameter_size: "1.5B", family: "qwen2" } }] });
  if (path === "/api/chat") return new Response('{"message":{"content":"pi"},"done":true}\n');
  return new Response("nope", { status: 404 });
};
const down = () => new Response("", { status: 530 });

test("/api/models merges both backends, prefixing Pi models and skipping /api/show for them", async () => {
  const res = await req("/api/models", { e: { ...hailoEnv, __fetch: byHost((p, i) => ollama(p, i), hailoUp) } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.models.map((m) => [m.name, m.backend]), [["deepseek-r1:8b", "desktop"], ["hailo/qwen2:1.5b", "hailo"], ["llama3.1:8b", "desktop"]]);
  assert.deepEqual(body.backends, { desktop: "online", hailo: "online" });
  assert.ok(!calls.some((c) => c.host === "hailo-tunnel.example" && c.path === "/api/show"));
  for (const c of calls.filter((c) => c.host === "hailo-tunnel.example")) assert.equal(c.init.headers["CF-Access-Client-Id"], "cid");
});

test("one backend offline still lists the other; both offline fails", async () => {
  let res = await quiet(() => req("/api/models", { e: { ...hailoEnv, __fetch: byHost(down, hailoUp) } }));
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.deepEqual(body.models.map((m) => m.name), ["hailo/qwen2:1.5b"]);
  assert.deepEqual(body.backends, { desktop: "offline", hailo: "online" });

  res = await quiet(() => req("/api/models", { e: { ...hailoEnv, __fetch: byHost(down, down) } }));
  assert.equal(res.status, 503);
  body = await res.json();
  assert.equal(body.error, "offline");
  assert.deepEqual(body.backends, { desktop: "offline", hailo: "offline" });
});

test("unconfigured desktop is left out; unprefixed models are not_configured", async () => {
  const e = { ...hailoEnv, OLLAMA_URL: "", __fetch: byHost(() => { throw new Error("desktop called"); }, hailoUp) };
  let res = await req("/api/models", { e });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.models.map((m) => m.name), ["hailo/qwen2:1.5b"]);
  assert.deepEqual(body.backends, { hailo: "online" });

  res = await req("/api/chat", { method: "POST", body: chatBody, e });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "not_configured", backend: "desktop" });
  assert.ok(!calls.some((c) => c.host === "ollama-tunnel.example"));
});

test("hailo/ models route to the Pi with the prefix stripped and no think flag", async () => {
  const e = { ...hailoEnv, __fetch: byHost((p, i) => ollama(p, i), hailoUp) };
  const res = await req("/api/chat", { method: "POST", body: { ...chatBody, model: "hailo/qwen2:1.5b", think: true }, e });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"pi"/);
  const c = calls.find((c) => c.path === "/api/chat");
  assert.equal(c.host, "hailo-tunnel.example");
  const sent = JSON.parse(c.init.body);
  assert.equal(sent.model, "qwen2:1.5b");
  assert.equal(sent.think, undefined);
});

test("Pi failures name the backend; unconfigured Pi is not_configured", async () => {
  let res = await quiet(() => req("/api/chat", { method: "POST", body: { ...chatBody, model: "hailo/qwen2:1.5b" }, e: { ...hailoEnv, __fetch: byHost(down, down) } }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "offline", backend: "hailo" });

  calls = [];
  res = await req("/api/chat", { method: "POST", body: { ...chatBody, model: "hailo/qwen2:1.5b" } });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).error, "not_configured");
  assert.equal(calls.length, 0);

  res = await req("/api/chat", { method: "POST", body: { ...chatBody, model: "hailo/" }, e: hailoEnv });
  assert.equal(res.status, 400);
});

// ---------- LocalAI on the desktop (OpenAI API) ----------
const LOCALAI = "localai-tunnel.example";
const laEnv = { ...env, OLLAMA_URL: "", LOCALAI_URL: `https://${LOCALAI}` };
const byHost3 = (localai, other = () => { throw new Error("unexpected host"); }) => async (input, init = {}) => {
  const url = new URL(input);
  if (url.host === TEAM) return fakeFetch(input, init);
  calls.push({ host: url.host, path: url.pathname, init });
  return (url.host === LOCALAI ? localai : other)(url.pathname, init);
};
const sse = (events) => new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
const delta = (d) => ({ choices: [{ index: 0, delta: d }] });
const localaiUp = (path, init) => {
  if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: "llama-3.1-8b-instruct" }, { id: "deepseek-r1-distill-qwen-7b" }, { id: "text-embedding-ada-002" }] });
  if (path === "/v1/chat/completions") return sse([delta({ role: "assistant" }), delta({ reasoning_content: "hmm" }), delta({ content: "Hel" }), delta({ content: "lo" }), "[DONE]"]);
  return new Response("nope", { status: 404 });
};
const ndjson = async (res) => (await res.text()).trim().split("\n").map((l) => JSON.parse(l));

test("LocalAI models are listed as rtx/<id> from /v1/models; LOCALAI_MODELS filters them", async () => {
  let res = await req("/api/models", { e: { ...laEnv, __fetch: byHost3(localaiUp) } });
  assert.equal(res.status, 200);
  let body = await res.json();
  assert.deepEqual(body.models.map((m) => [m.name, m.backend]), [
    ["rtx/deepseek-r1-distill-qwen-7b", "localai"], ["rtx/llama-3.1-8b-instruct", "localai"], ["rtx/text-embedding-ada-002", "localai"],
  ]);
  assert.deepEqual(body.backends, { localai: "online" });
  assert.deepEqual(calls.map((c) => c.path), ["/v1/models"]);
  assert.equal(calls[0].init.headers["CF-Access-Client-Id"], "cid");
  assert.equal(calls[0].init.headers.authorization, undefined);

  calls = [];
  res = await req("/api/models", { e: { ...laEnv, LOCALAI_MODELS: " llama-3.1-8b-instruct , deepseek-r1-distill-qwen-7b", LOCALAI_API_KEY: "k", __fetch: byHost3(localaiUp) } });
  body = await res.json();
  assert.deepEqual(body.models.map((m) => m.name), ["rtx/deepseek-r1-distill-qwen-7b", "rtx/llama-3.1-8b-instruct"]);
  assert.equal(calls[0].init.headers.authorization, "Bearer k");
});

test("rtx/ chat goes to /v1/chat/completions and streams back as Ollama NDJSON", async () => {
  const res = await req("/api/chat", { method: "POST", body: { ...chatBody, model: "rtx/llama-3.1-8b-instruct", think: true }, e: { ...laEnv, __fetch: byHost3(localaiUp) } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  assert.deepEqual(await ndjson(res), [
    { message: { role: "assistant", content: "", thinking: "hmm" }, done: false },
    { message: { role: "assistant", content: "Hel" }, done: false },
    { message: { role: "assistant", content: "lo" }, done: false },
    { done: true },
  ]);
  const c = calls.find((c) => c.path === "/v1/chat/completions");
  assert.equal(c.host, LOCALAI);
  const sent = JSON.parse(c.init.body);
  assert.deepEqual(Object.keys(sent).sort(), ["messages", "model", "stream"]);
  assert.equal(sent.model, "llama-3.1-8b-instruct");
  assert.equal(sent.stream, true);
  assert.equal(sent.messages[0].role, "system");
});

test("LocalAI: allowlist blocks other models; failures name the backend; OpenAI error bodies give a detail", async () => {
  let res = await req("/api/chat", { method: "POST", body: { ...chatBody, model: "rtx/text-embedding-ada-002" }, e: { ...laEnv, LOCALAI_MODELS: "llama-3.1-8b-instruct", __fetch: byHost3(localaiUp) } });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);

  res = await quiet(() => req("/api/chat", { method: "POST", body: { ...chatBody, model: "rtx/x" }, e: { ...laEnv, __fetch: byHost3(down) } }));
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "offline", backend: "localai" });

  const bad = () => Response.json({ error: { code: 500, message: "could not load model", type: "" } }, { status: 500 });
  res = await quiet(() => req("/api/chat", { method: "POST", body: { ...chatBody, model: "rtx/x" }, e: { ...laEnv, __fetch: byHost3(bad) } }));
  assert.equal(res.status, 502);
  assert.deepEqual(await res.json(), { error: "upstream", backend: "localai", status: 500, detail: "could not load model" });

  res = await req("/api/chat", { method: "POST", body: { ...chatBody, model: "rtx/x" }, e: { ...env, OLLAMA_URL: "" } });
  assert.equal(res.status, 503);
  assert.deepEqual(await res.json(), { error: "not_configured", backend: "localai" });
});

test("sseToNdjson handles split chunks, CRLF, comments, mid-stream errors and a missing [DONE]", async () => {
  const run = async (chunks) => {
    const enc = new TextEncoder();
    const src = new ReadableStream({ start(c) { for (const ch of chunks) c.enqueue(enc.encode(ch)); c.close(); } });
    return (await new Response(src.pipeThrough(sseToNdjson())).text()).trim().split("\n").map((l) => JSON.parse(l));
  };
  assert.deepEqual(await run([": keepalive\r\n\r\ndata: {\"choices\":[{\"delta\":{\"con", "tent\":\"a\"}}]}\r\n\r\n", "data: {\"choices\":[{\"delta\":{\"content\":\"b\"}}]}"]), [
    { message: { role: "assistant", content: "a" }, done: false },
    { message: { role: "assistant", content: "b" }, done: false },
    { done: true },
  ]);
  assert.deepEqual(await run(['data: {"choices":[{"delta":{"content":"a"}}]}\n\n', 'data: {"error":{"message":"out of memory"}}\n\n', 'data: {"choices":[{"delta":{"content":"z"}}]}\n\n']), [
    { message: { role: "assistant", content: "a" }, done: false },
    { error: "out of memory", done: true },
  ]);
});

test("all three backends merge into one list", async () => {
  const e = { ...env, LOCALAI_URL: `https://${LOCALAI}`, HAILO_URL: "https://hailo-tunnel.example",
    __fetch: byHost3(localaiUp, (p, i) => (p.startsWith("/api/") ? (calls.at(-1).host === "hailo-tunnel.example" ? hailoUp(p, i) : ollama(p, i)) : new Response("", { status: 404 }))) };
  const body = await (await req("/api/models", { e })).json();
  assert.deepEqual(body.backends, { desktop: "online", localai: "online", hailo: "online" });
  assert.deepEqual([...new Set(body.models.map((m) => m.backend))].sort(), ["desktop", "hailo", "localai"]);
});

// ---------- public mode ----------
// A fake Workers rate limiter: allows `limit` calls per key.
const limiter = (limit) => {
  const seen = new Map();
  return { keys: seen, async limit({ key }) { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= limit }; } };
};
const publicEnv = (over = {}) => ({ ...env, PUBLIC: "true", ACCESS_AUD: "", CHAT_LIMIT: limiter(2), MODELS_LIMIT: limiter(5), DB: fakeD1(), ...over });
const anon = (path, e, { method = "GET", body, ip = "203.0.113.7", visitor = "visitor-0000000000000001" } = {}) =>
  worker.fetch(new Request(`https://ai.melltron.build${path}`, { method, headers: { "content-type": "application/json", "cf-connecting-ip": ip, "x-ai-visitor": visitor }, body: body && JSON.stringify(body) }), e, {});

test("public mode serves models and chat with no Access token", async () => {
  const e = publicEnv();
  const me = await anon("/api/me", e);
  assert.equal(me.status, 200);
  assert.deepEqual(await me.json(), { email: null, public: true });
  assert.equal((await anon("/api/models", e)).status, 200);
  const res = await anon("/api/chat", e, { method: "POST", body: chatBody });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"llo"/);
  // The tunnel still gets the service token.
  assert.equal(calls.find((c) => c.path === "/api/chat").init.headers["CF-Access-Client-Id"], "cid");
});

test("public chat is rate limited per IP", async () => {
  const e = publicEnv();
  for (let i = 0; i < 2; i++) assert.equal((await anon("/api/chat", e, { method: "POST", body: chatBody })).status, 200);
  const before = calls.length;
  const res = await anon("/api/chat", e, { method: "POST", body: chatBody });
  assert.equal(res.status, 429);
  assert.equal((await res.json()).error, "rate_limited");
  assert.equal(calls.length, before, "a limited request never reaches the GPU");
  assert.equal((await anon("/api/chat", e, { method: "POST", body: chatBody, ip: "198.51.100.1" })).status, 200, "other IPs unaffected");
  assert.deepEqual([...e.CHAT_LIMIT.keys.keys()], ["203.0.113.7", "198.51.100.1"]);
});

test("public mode fails closed without rate-limit bindings", async () => {
  const e = publicEnv({ CHAT_LIMIT: undefined, MODELS_LIMIT: undefined });
  for (const [p, init] of [["/api/models", {}], ["/api/chat", { method: "POST", body: chatBody }]]) {
    const res = await anon(p, e, init);
    assert.equal(res.status, 503, p);
    assert.equal((await res.json()).error, "rate_limit_not_configured");
  }
  assert.equal(calls.length, 0);
});

test("PUBLIC must be exactly \"true\"; anything else still requires Access", async () => {
  for (const PUBLIC of ["", "false", "1", "TRUE"]) {
    const res = await quiet(() => anon("/api/models", { ...env, PUBLIC }));
    assert.equal(res.status, 401, PUBLIC);
  }
});
