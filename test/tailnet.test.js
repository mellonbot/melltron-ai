// CHAT_ACCESS defaults to tailnet: models and chat need a valid tailnet pass.
// "public" is the previous free-prompt policy and is covered in quota.test.js.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { _resetAccessCache } from "../src/access.js";
import { _resetSchema, signPass } from "../src/quota.js";
import { fakeD1 } from "./d1.js";

const TEAM = "lab.cloudflareaccess.com";
const ADMIN_AUD = "admin-aud";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
const MESSAGE = "This chat is currently limited to the private network. From a device on that network, open the tailnet pass page and it will send you back here.";
const STALE = "This chat is limited to the private network, and the pass saved in this browser is no longer valid. Open the tailnet pass page again from a device on that network.";

const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function jwt(aud = ADMIN_AUD) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [aud], email: "owner@example.com", sub: "owner", exp: now + 600, iat: now }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

let calls;
const unlimitedRl = { limit: async () => ({ success: true }) };
const limiter = (limit) => {
  const seen = new Map();
  return { async limit({ key }) { const n = (seen.get(key) ?? 0) + 1; seen.set(key, n); return { success: n <= limit }; } };
};
let env;
let pass;

beforeEach(async () => {
  _resetAccessCache();
  _resetSchema();
  calls = [];
  pass = await signPass({ dev: "mellon-laptop-1", user: "owner@example.com", exp: Math.floor(Date.now() / 1000) + 3600 }, SECRET);
  env = {
    ASSETS: { fetch: async () => new Response("x") },
    PUBLIC: "true", FREE_PROMPTS: "10",
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "", ADMIN_ACCESS_AUD: ADMIN_AUD,
    OLLAMA_URL: "https://ollama.example", OLLAMA_CLIENT_ID: "cid", OLLAMA_CLIENT_SECRET: "cs",
    PASS_SECRET: SECRET, CHAT_LIMIT: unlimitedRl, MODELS_LIMIT: unlimitedRl, DB: fakeD1(),
    __fetch: async (input) => {
      const url = new URL(input);
      if (url.host === TEAM) return Response.json({ keys: [jwk] });
      calls.push(url.pathname);
      if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "llama3.1:8b", details: {} }] });
      if (url.pathname === "/api/show") return Response.json({ capabilities: [] });
      if (url.pathname === "/api/chat") return new Response('{"message":{"content":"ok"},"done":true}\n');
      return new Response("nope", { status: 404 });
    },
  };
});

const V1 = "visitor-aaaaaaaaaaaaaaaa";
function req(path, { method = "GET", body, ip = "203.0.113.7", visitor = V1, token, auth, e = env } = {}) {
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (visitor) headers["x-ai-visitor"] = visitor;
  if (token) headers["x-ai-pass"] = token;
  if (auth) headers["cf-access-jwt-assertion"] = auth;
  return worker.fetch(new Request(`https://ai.melltron.build${path}`, { method, headers, body: body && JSON.stringify(body) }), e, {});
}
const chatBody = { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] };
const chat = (opts = {}) => req("/api/chat", { method: "POST", body: chatBody, ...opts });
const quiet = async (fn) => { const w = console.warn, er = console.error; console.warn = console.error = () => {}; try { return await fn(); } finally { console.warn = w; console.error = er; } };

test("the default, and anything other than public, is tailnet-only", async () => {
  for (const CHAT_ACCESS of [undefined, "tailnet", "", "yes", "TRUE", "Public"]) {
    const e = { ...env, CHAT_ACCESS };
    const models = await req("/api/models", { e });
    assert.equal(models.status, 403, String(CHAT_ACCESS));
    const body = await models.json();
    assert.equal(body.error, "tailnet_only");
    assert.equal(body.message, MESSAGE);
    assert.equal(body.quota.tier, "closed");
    assert.equal(body.quota.remaining, 0);
    assert.equal(body.quota.limit, 0);
    assert.equal((await chat({ e })).status, 403);
  }
  assert.equal(calls.length, 0, "a stranger never reaches the model");
});

test("CHAT_ACCESS=public is the only way to reopen free prompts", async () => {
  const cases = [["public", V1, "203.0.113.7"], [" public ", "visitor-bbbbbbbbbbbbbbbb", "198.51.100.9"]];
  for (const [CHAT_ACCESS, visitor, ip] of cases) {
    const e = { ...env, CHAT_ACCESS, FREE_PROMPTS: "1" };
    assert.equal((await (await req("/api/quota", { e, visitor, ip })).json()).tier, "free", CHAT_ACCESS);
    assert.equal((await chat({ e, visitor, ip })).status, 200);
  }
  const list = await (await req("/api/admin/visitors", { auth: await jwt(), e: { ...env, CHAT_ACCESS: "public" } })).json();
  assert.equal(list.chatAccess, "public");
});

test("a visitor with no pass gets zero prompts and cannot ask for access", async () => {
  const box = { sent: [], async send(m) { this.sent.push(m); } };
  const e = { ...env, ALERT_EMAIL: box, ALERT_TO: "owner@example.com", ALERT_FROM: "ai@melltron.build" };
  const quota = await (await req("/api/quota", { e, visitor: null })).json();
  assert.deepEqual(quota, {
    tier: "closed", used: 0, limit: 0, remaining: 0, requested: false, device: null, passInvalid: false, message: MESSAGE,
  });
  const ask = await req("/api/access-request", { method: "POST", body: { name: "Sam", note: "please" }, e });
  assert.equal(ask.status, 403);
  assert.equal((await ask.json()).error, "tailnet_only");
  assert.equal(box.sent.length, 0);
  const listed = await (await req("/api/admin/visitors", { auth: await jwt(), e })).json();
  assert.deepEqual(listed.visitors, []);
  assert.equal(calls.length, 0);
});

test("a stale pass is refused and says so, without using the free tier", async () => {
  const stale = await signPass({ dev: "old", user: "u", exp: Math.floor(Date.now() / 1000) - 5 }, SECRET);
  const quota = await (await req("/api/quota", { token: stale })).json();
  assert.equal(quota.tier, "closed");
  assert.equal(quota.passInvalid, true);
  assert.equal(quota.remaining, 0);
  assert.equal(quota.message, STALE);
  const models = await req("/api/models", { token: "not-a-pass" });
  assert.equal((await models.json()).message, STALE);
  assert.equal(calls.length, 0);
});

test("a valid tailnet pass lists models and chats, with no database row", async () => {
  const models = await req("/api/models", { token: pass });
  assert.equal(models.status, 200);
  assert.equal((await models.json()).models[0].name, "llama3.1:8b");
  for (let i = 0; i < 4; i++) assert.equal((await chat({ token: pass })).status, 200);
  const quota = await (await req("/api/quota", { token: pass })).json();
  assert.equal(quota.tier, "tailnet");
  assert.equal(quota.device, "mellon-laptop-1");
  assert.equal(quota.remaining, null);
  const listed = await (await req("/api/admin/visitors", { auth: await jwt() })).json();
  assert.deepEqual(listed.visitors, []);
});

test("a tailnet pass still works when D1 is missing, and still needs the rate limits", async () => {
  const noDb = { ...env, DB: undefined };
  assert.equal((await req("/api/models", { token: pass, e: noDb })).status, 200);
  assert.equal((await chat({ token: pass, e: noDb })).status, 200);
  assert.equal((await (await req("/api/quota", { token: pass, e: noDb })).json()).tier, "tailnet");
  assert.equal((await req("/api/models", { e: noDb })).status, 403);

  const noLimit = { ...env, CHAT_LIMIT: undefined, MODELS_LIMIT: undefined };
  assert.equal((await req("/api/models", { token: pass, e: noLimit })).status, 503);
  assert.equal((await (await req("/api/models", { e: noLimit })).json()).error, "tailnet_only");
});

test("tailnet chat stays rate limited per IP and does not spend the limit on strangers", async () => {
  const e = { ...env, CHAT_LIMIT: limiter(1) };
  assert.equal((await chat({ token: pass, e })).status, 200);
  assert.equal((await chat({ token: pass, e })).status, 429);
  const before = calls.length;
  assert.equal((await chat({ e })).status, 403);
  assert.equal((await chat({ token: pass, e, ip: "198.51.100.8" })).status, 200);
  assert.equal(calls.length, before + 1);
});

test("an owner approval does not open chat while access is tailnet-only", async () => {
  const open = { ...env, CHAT_ACCESS: "public" };
  for (let i = 0; i < 10; i++) assert.equal((await chat({ e: open })).status, 200);
  assert.equal((await req("/api/access-request", { method: "POST", body: { name: "Sam" }, e: open })).status, 200);
  const auth = await jwt();
  assert.equal((await req("/api/admin/visitors", { method: "POST", auth, body: { id: V1, action: "approve" }, e: open })).status, 200);
  assert.equal((await (await req("/api/quota", { e: open })).json()).tier, "approved");

  const before = calls.length;
  const denied = await chat();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "tailnet_only");
  assert.equal((await (await req("/api/quota")).json()).tier, "closed");
  assert.equal(calls.length, before, "approval is stored, not a way onto the model");
  assert.equal((await chat({ token: pass })).status, 200);
});

test("admin, health, ping, and repo-qa stay off the tailnet gate", async () => {
  assert.equal((await req("/_health")).status, 200);
  assert.equal((await (await req("/api/ping")).json()).ok, true);
  const auth = await jwt();
  const list = await (await req("/api/admin/visitors", { auth })).json();
  assert.equal(list.chatAccess, "tailnet");
  assert.deepEqual(list.visitors, []);
  assert.equal((await req("/api/admin/visitors", { method: "POST", auth, body: { id: V1, action: "reset" } })).status, 404);

  const qa = await quiet(() => req("/api/repo-qa", { method: "POST", body: { repository: "mellonbot/melltron-ai", question: "How is access verified?" } }));
  assert.equal(qa.status, 503);
  assert.equal((await qa.json()).error, "access_not_configured");
  assert.equal(calls.length, 0);

  const locked = { ...env, PUBLIC: "", ACCESS_AUD: ADMIN_AUD };
  assert.equal((await quiet(() => req("/api/models", { token: pass, e: locked }))).status, 401);
  assert.equal((await req("/api/models", { token: pass, auth, e: locked })).status, 200);
});
