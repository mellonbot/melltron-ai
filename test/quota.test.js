// Public-mode prompt quota: free prompts, tailnet passes, access requests, admin.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { _resetAccessCache } from "../src/access.js";
import { _resetSchema, signPass, verifyPass } from "../src/quota.js";
import { fakeD1 } from "./d1.js";

const TEAM = "lab.cloudflareaccess.com";
const ADMIN_AUD = "admin-aud";
const SECRET = "test-secret-0123456789abcdef0123456789abcdef";
// Minted by tools/tailnet-pass.py's sign() with SECRET; exp = 2100-01-01.
const PY_PASS = "eyJkZXYiOiJtZWxsb24tbGFwdG9wLTEiLCJ1c2VyIjoib3duZXJAZXhhbXBsZS5jb20iLCJleHAiOjQxMDI0NDQ4MDB9.abKo_CDFct0MD-hAXk0V2PxeAkU_NfakwQr7SBfgaqM";

// --- Access JWTs for the admin routes ---
const { privateKey, publicKey } = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", publicKey)), kid: "k1" };
const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function jwt(aud = ADMIN_AUD) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const p = b64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [aud], email: "owner@example.com", exp: now + 600, iat: now }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64url(sig)}`;
}

let calls, upstream;
const fakeFetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.host === TEAM) return Response.json({ keys: [jwk] });
  calls.push(url.pathname);
  return upstream(url.pathname, init);
};
const unlimitedRl = { limit: async () => ({ success: true }) };
let env;

beforeEach(() => {
  _resetAccessCache();
  _resetSchema();
  calls = [];
  upstream = (path) => {
    if (path === "/api/chat") return new Response('{"message":{"content":"ok"},"done":true}\n');
    if (path === "/api/tags") return Response.json({ models: [] });
    return new Response("nope", { status: 404 });
  };
  env = {
    ASSETS: { fetch: async () => new Response("x") },
    PUBLIC: "true", FREE_PROMPTS: "3",
    ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "", ADMIN_ACCESS_AUD: ADMIN_AUD,
    OLLAMA_URL: "https://ollama.example", OLLAMA_CLIENT_ID: "cid", OLLAMA_CLIENT_SECRET: "cs",
    PASS_SECRET: SECRET, CHAT_LIMIT: unlimitedRl, MODELS_LIMIT: unlimitedRl, DB: fakeD1(),
    __fetch: fakeFetch,
  };
});

const V1 = "visitor-aaaaaaaaaaaaaaaa";
const V2 = "visitor-bbbbbbbbbbbbbbbb";
function req(path, { method = "GET", body, ip = "203.0.113.7", visitor = V1, pass, auth, e = env } = {}) {
  const headers = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (visitor) headers["x-ai-visitor"] = visitor;
  if (pass) headers["x-ai-pass"] = pass;
  if (auth) headers["cf-access-jwt-assertion"] = auth;
  return worker.fetch(new Request(`https://ai.melltron.build${path}`, { method, headers, body: body && JSON.stringify(body) }), e, {});
}
const chat = (opts = {}) => req("/api/chat", { method: "POST", body: { model: "llama3.1:8b", messages: [{ role: "user", content: "hi" }] }, ...opts });
const quota = async (opts) => (await req("/api/quota", opts)).json();
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

// ---------- passes ----------
test("passes: JS round-trip, Python-minted vector, and every way to be wrong", async () => {
  const exp = Math.floor(Date.now() / 1000) + 60;
  const t = await signPass({ dev: "pi", user: "u", exp }, SECRET);
  assert.deepEqual(await verifyPass(t, SECRET), { dev: "pi", user: "u" });
  assert.deepEqual(await verifyPass(PY_PASS, SECRET), { dev: "mellon-laptop-1", user: "owner@example.com" });

  const expired = await signPass({ dev: "pi", exp: Math.floor(Date.now() / 1000) - 1 }, SECRET);
  const [p, s] = t.split(".");
  const forged = `${Buffer.from(JSON.stringify({ dev: "x", exp: 4102444800 })).toString("base64url")}.${s}`;
  for (const bad of [expired, forged, `${p}.${s}x`, `${p}.${s}.extra`, "garbage", "", null, "a".repeat(3000)]) {
    assert.equal(await verifyPass(bad, SECRET), null, String(bad).slice(0, 20));
  }
  assert.equal(await verifyPass(t, "another-secret-another-secret-0000"), null);
  assert.equal(await verifyPass(t, ""), null, "no secret configured = no passes");
});

// ---------- free tier ----------
test("visitors get FREE_PROMPTS chats, then 403 quota_exhausted without touching the GPU", async () => {
  assert.deepEqual(await quota(), { tier: "free", used: 0, limit: 3, remaining: 3, requested: false, device: null, passInvalid: false });
  for (let i = 0; i < 3; i++) assert.equal((await chat()).status, 200);
  const before = calls.length;
  const res = await chat();
  assert.equal(res.status, 403);
  const body = await res.json();
  assert.equal(body.error, "quota_exhausted");
  assert.equal(body.quota.tier, "exhausted");
  assert.equal(calls.length, before);
  assert.equal((await quota()).remaining, 0);
});

test("a new browser on the same IP doesn't get fresh prompts; another IP and browser does", async () => {
  for (let i = 0; i < 3; i++) await chat();
  assert.equal((await chat({ visitor: V2 })).status, 403, "same IP, cleared browser");
  assert.equal((await chat({ visitor: V2, ip: "198.51.100.9" })).status, 200, "different person");
});

test("failed upstream calls don't use up prompts", async () => {
  upstream = () => new Response("", { status: 530 });
  assert.equal((await quiet(() => chat())).status, 503);
  assert.equal((await quota()).used, 0);
});

test("a visitor id is required in public mode", async () => {
  assert.equal((await chat({ visitor: null })).status, 400);
  assert.equal((await chat({ visitor: "short" })).status, 400);
  assert.equal((await req("/api/quota", { visitor: "bad id with spaces!!" })).status, 400);
});

test("public mode fails closed without the database", async () => {
  const e = { ...env, DB: undefined };
  assert.equal((await chat({ e })).status, 503);
  assert.equal((await req("/api/quota", { e })).status, 503);
});

test("private mode doesn't count anything", async () => {
  const e = { ...env, PUBLIC: "", ACCESS_AUD: ADMIN_AUD };
  assert.deepEqual(await (await req("/api/quota", { e, auth: await jwt() })).json(), { tier: "private" });
});

// ---------- tailnet ----------
test("a tailnet pass is unlimited and isn't recorded", async () => {
  for (let i = 0; i < 6; i++) assert.equal((await chat({ pass: PY_PASS })).status, 200);
  const q = await quota({ pass: PY_PASS });
  assert.equal(q.tier, "tailnet");
  assert.equal(q.device, "mellon-laptop-1");
  // Tailnet use doesn't eat the IP's free prompts either, and leaves no rows.
  assert.equal((await quota()).remaining, 3);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM visitors").get().n, 0);
  assert.equal(env.DB.raw.prepare("SELECT COUNT(*) AS n FROM ips").get().n, 0);
});

test("a bad or expired pass falls back to the free tier and says so", async () => {
  const q = await quota({ pass: PY_PASS.slice(0, -2) + "xx" });
  assert.equal(q.tier, "free");
  assert.equal(q.passInvalid, true);
  const noSecret = await quota({ pass: PY_PASS, e: { ...env, PASS_SECRET: "" } });
  assert.equal(noSecret.tier, "free");
});

// ---------- access requests + admin ----------
test("request → pending → approve → unlimited; deny and reset work too", async () => {
  for (let i = 0; i < 3; i++) await chat();
  assert.equal((await req("/api/access-request", { method: "POST", body: { note: "no name" } })).status, 400);
  const r = await req("/api/access-request", { method: "POST", body: { name: "  Sam\u0000 ", note: "a friend of the owner".repeat(50) } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tier, "pending");
  assert.equal((await chat()).status, 403, "pending still can't chat");

  const auth = await jwt();
  const list = await (await req("/api/admin/visitors", { auth })).json();
  assert.equal(list.visitors[0].status, "pending");
  assert.equal(list.visitors[0].name, "Sam");
  assert.equal(list.visitors[0].note.length, 500);
  assert.equal(list.freePrompts, 3);

  const decide = (action, id = V1) => req("/api/admin/visitors", { method: "POST", auth, body: { id, action } });
  assert.equal((await decide("approve")).status, 200);
  assert.equal((await quota()).tier, "approved");
  for (let i = 0; i < 4; i++) assert.equal((await chat()).status, 200);

  assert.equal((await decide("deny")).status, 200);
  const denied = await chat();
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, "denied");
  // A denied visitor can't flip themselves back to pending.
  await req("/api/access-request", { method: "POST", body: { name: "Sam again" } });
  assert.equal((await quota()).tier, "denied");

  assert.equal((await decide("reset")).status, 200);
  const q = await quota();
  assert.equal(q.tier, "free");
  assert.equal(q.remaining, 3, "visitor and IP counts both reset");

  assert.equal((await decide("approve", "visitor-zzzzzzzzzzzzzzzz")).status, 404);
  assert.equal((await req("/api/admin/visitors", { method: "POST", auth, body: { id: V1, action: "delete" } })).status, 400);
});

test("admin routes need the admin Access app's JWT", async () => {
  assert.equal((await quiet(() => req("/api/admin/visitors"))).status, 401);
  const other = await jwt("some-other-app");
  assert.equal((await quiet(() => req("/api/admin/visitors", { auth: other }))).status, 401);
  assert.equal((await req("/api/admin/visitors", { auth: await jwt(), e: { ...env, ADMIN_ACCESS_AUD: "" } })).status, 503);
  assert.equal((await quiet(() => req("/api/admin/visitors", { method: "POST", body: { id: V1, action: "approve" } }))).status, 401);
  assert.equal((await req("/api/admin/visitors", { auth: await jwt() })).status, 200);
});
