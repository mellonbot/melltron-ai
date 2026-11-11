// API: Access gating, Ollama proxying, validation and error mapping.
// Ollama and the Access certs endpoint are faked through env.__fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { _resetAccessCache } from "../src/access.js";
import { validateChat, LIMITS } from "../src/api.js";

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
  assert.deepEqual(await res.json(), { email: "me@example.com" });
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
  assert.deepEqual(sent, { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }], stream: true, think: true });
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
