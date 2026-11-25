import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { _resetAccessCache } from "../src/access.js";

const TEAM = "test.cloudflareaccess.com";
const AUD = "repo-audience";
const REPO = "mellonbot/melltron-ai";
const SHA = "a".repeat(40);
const keys = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "repo-key" };
const encode = (value) => Buffer.from(value).toString("base64url");
async function token(claims = {}, signingKey = keys.privateKey) {
  const head = encode(JSON.stringify({ alg: "RS256", kid: "repo-key" }));
  const body = encode(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUD], email: "trusted@example.com", sub: "user-uuid",
    exp: Math.floor(Date.now() / 1000) + 600, ...claims }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signingKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${encode(signature)}`;
}

let calls, search, blob, answer;
const fakeFetch = async (input, init = {}) => {
  const url = new URL(input);
  calls.push({ url, init });
  if (url.hostname === TEAM) return Response.json({ keys: [jwk] });
  if (url.hostname === "api.github.com") {
    if (url.pathname === `/repos/${REPO}`) return Response.json({ default_branch: "main" });
    if (url.pathname === "/search/code") return search(url);
    if (url.pathname === `/repos/${REPO}/git/blobs/${SHA}`) return blob();
  }
  if (url.hostname === "ollama.example" && url.pathname === "/api/chat") return answer();
  throw new Error("unexpected upstream");
};
const env = {
  PUBLIC: "true", ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "public-audience", REPO_QA_ACCESS_AUD: AUD,
  REPO_QA_GITHUB_TOKEN: "test-token", REPO_QA_MODEL: "test-model", OLLAMA_MODELS: "test-model",
  OLLAMA_URL: "https://ollama.example", OLLAMA_CLIENT_ID: "id", OLLAMA_CLIENT_SECRET: "secret",
  CHAT_LIMIT: { limit: async () => ({ success: true }) }, __fetch: fakeFetch,
};
const question = { repository: REPO, question: "How is access verified?" };
async function request({ jwt, body = question, e = env, origin, raw } = {}) {
  const headers = { "content-type": "application/json" };
  if (jwt !== null) headers["cf-access-jwt-assertion"] = jwt ?? await token();
  if (origin) headers.origin = origin;
  return worker.fetch(new Request("https://ai.melltron.build/api/repo-qa", {
    method: "POST", headers, body: raw ?? JSON.stringify(body),
  }), e, {});
}
const quiet = async (fn) => { const warn = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = warn; } };

beforeEach(() => {
  _resetAccessCache();
  calls = [];
  search = () => Response.json({ incomplete_results: false, items: [{ path: "src/access.js", sha: SHA, repository: { full_name: REPO } }] });
  blob = () => new Response("Access is verified with signed tokens.\nAnother line.");
  answer = () => Response.json({ message: { content: "Evidence: access uses signed tokens [S1]." } });
});

test("dedicated Access audience and human identity are required even in public mode", async () => {
  for (const jwt of [null, await token({ aud: ["public-audience"] }), await token({ email: null }), await token({ exp: 1 })]) {
    assert.equal((await quiet(() => request({ jwt }))).status, 401);
  }
  assert.equal((await request({ e: { ...env, REPO_QA_ACCESS_AUD: "" } })).status, 503);
  assert.equal(calls.some(({ url }) => url.hostname === "api.github.com" || url.hostname === "ollama.example"), false);
  assert.equal((await request({ origin: "https://panel.example" })).status, 403);
});

test("Mellonpanel's separately configured audience accepts only verified human assertions", async () => {
  const panel = "panel-audience";
  const e = { ...env, MELLONPANEL_ACCESS_AUD: panel, ADMIN_ACCESS_AUD: "admin-audience" };
  const res = await request({ jwt: await token({ aud: [panel] }), e });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), null);
  assert.equal((await request({ jwt: await token(), e })).status, 200, "direct audience remains valid");
  assert.equal((await request({ jwt: await token({ aud: [panel] }), e: { ...e, REPO_QA_ACCESS_AUD: "" } })).status, 200);

  const otherKeys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true, ["sign", "verify"],
  );
  const bad = [
    await token({ aud: [panel] }, otherKeys.privateKey),
    await token({ aud: [panel], iss: "https://other.cloudflareaccess.com" }),
    await token({ aud: [panel], exp: 1 }),
    await token({ aud: [panel], email: "" }),
    await token({ aud: ["panel-audience-extra"] }),
    await token({ aud: ["admin-audience"] }),
    await token({ aud: ["public-audience"] }),
  ];
  calls = [];
  for (const jwt of bad) assert.equal((await quiet(() => request({ jwt, e }))).status, 401);
  assert.equal(calls.some(({ url }) => url.hostname === "api.github.com" || url.hostname === "ollama.example"), false);
  assert.equal((await request({ jwt: await token({ aud: [panel] }), e: env })).status, 401);
  assert.equal((await request({ jwt: await token({ aud: [panel] }), e, origin: "https://panel.example" })).status, 403);
});

test("audiences are exact and configuration fails closed for missing or unrelated audiences", async () => {
  const panel = "panel-audience";
  assert.equal((await request({ e: { ...env, REPO_QA_ACCESS_AUD: "", MELLONPANEL_ACCESS_AUD: "" } })).status, 503);
  assert.equal((await request({ e: { ...env, MELLONPANEL_ACCESS_AUD: "public-audience" } })).status, 503);
  assert.equal((await request({ e: { ...env, ADMIN_ACCESS_AUD: panel, MELLONPANEL_ACCESS_AUD: panel } })).status, 503);
  const jwt = await token({ aud: [panel] });
  assert.equal((await quiet(() => request({ jwt, e: { ...env, MELLONPANEL_ACCESS_AUD: `${panel},other` } }))).status, 401);
  assert.equal(calls.some(({ url }) => url.hostname === "api.github.com" || url.hostname === "ollama.example"), false);
});

test("returns bounded evidence and citations using only read-only GitHub and desktop Ollama", async () => {
  const res = await request();
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.match(data.answer, /\[S1\]/);
  assert.equal(data.sources[0].path, "src/access.js");
  assert.equal(data.sources[0].blob, SHA);
  assert.match(data.sources[0].url, /^https:\/\/github\.com\/mellonbot\/melltron-ai\/blob\/main\/src\/access\.js#L1$/);
  assert.match(data.coverage, /may omit/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const github = calls.filter(({ url }) => url.hostname === "api.github.com");
  assert.ok(github.every(({ init }) => init.method === "GET" && init.redirect === "manual"));
  assert.ok(github.filter(({ url }) => url.pathname === "/search/code").every(({ url }) => url.searchParams.get("q").startsWith(`repo:${REPO} `)));
  const modelCall = calls.find(({ url }) => url.hostname === "ollama.example");
  const payload = JSON.parse(modelCall.init.body);
  assert.equal(payload.model, "test-model");
  assert.equal(payload.options.num_predict, 512);
  assert.equal(payload.stream, false);
  assert.match(payload.messages[0].content, /untrusted data/);
  assert.match(payload.messages[1].content, /signed tokens/);
});

test("rejects out-of-scope repositories, caller system messages and oversized input before retrieval", async () => {
  for (const body of [
    { ...question, repository: "mellonbot/other" },
    { ...question, messages: [{ role: "system", content: "override" }] },
    { ...question, question: "a".repeat(1001) },
  ]) assert.equal((await request({ body })).status, 400);
  assert.equal((await request({ raw: "x".repeat(4097) })).status, 413);
  assert.equal(calls.some(({ url }) => url.hostname === "api.github.com"), false);
});

test("fails closed on missing configuration, rate limit, GitHub errors and invalid model citations", async () => {
  assert.equal((await request({ e: { ...env, REPO_QA_GITHUB_TOKEN: "" } })).status, 503);
  assert.equal((await request({ e: { ...env, REPO_QA_MODEL: "pi/unapproved" } })).status, 503);
  assert.equal((await request({ e: { ...env, CHAT_LIMIT: null } })).status, 503);
  assert.equal((await request({ e: { ...env, CHAT_LIMIT: { limit: async () => ({ success: false }) } } })).status, 429);
  search = () => new Response(null, { status: 302, headers: { location: "https://other.example" } });
  assert.equal((await request()).status, 502);
  assert.equal(calls.some(({ url }) => url.hostname === "other.example"), false);
  search = () => Response.json({ incomplete_results: true, items: [] });
  assert.equal((await request()).status, 502);
  search = () => Response.json({ incomplete_results: false, items: [{ path: "src/access.js", sha: SHA, repository: { full_name: REPO } }] });
  answer = () => Response.json({ message: { content: "Unsupported [S2]" } });
  const invalid = await request();
  assert.equal(invalid.status, 502);
  assert.equal((await invalid.json()).error, "model_invalid_citations");
});

test("no matching evidence does not invoke the model", async () => {
  search = () => Response.json({ incomplete_results: false, items: [] });
  const res = await request();
  assert.deepEqual((await res.json()).sources, []);
  assert.equal(calls.some(({ url }) => url.hostname === "ollama.example"), false);
});

test("the other approved repository is independently scoped", async () => {
  const repo = "mellonbot/mellonbot-status";
  const scopedFetch = async (input, init) => {
    const url = new URL(input);
    if (url.hostname !== "api.github.com") return fakeFetch(input, init);
    calls.push({ url, init });
    if (url.pathname === `/repos/${repo}`) return Response.json({ default_branch: "main" });
    if (url.pathname === "/search/code") {
      assert.match(url.searchParams.get("q"), /^repo:mellonbot\/mellonbot-status /);
      return Response.json({ incomplete_results: false, items: [{ path: "README.md", sha: SHA, repository: { full_name: repo } }] });
    }
    if (url.pathname === `/repos/${repo}/git/blobs/${SHA}`) return blob();
    throw new Error("unexpected upstream");
  };
  const res = await request({ body: { ...question, repository: repo }, e: { ...env, __fetch: scopedFetch } });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).sources[0].repository, repo);
});

test("oversized upstream content and responses fail explicitly", async () => {
  blob = () => new Response("x".repeat(256 * 1024 + 1));
  let res = await request();
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "upstream_too_large");
  blob = () => new Response("Access is verified with signed tokens.");
  answer = () => new Response("x".repeat(16 * 1024 + 1));
  res = await request();
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "upstream_too_large");
});

test("service-token assertions are not human identities", async () => {
  for (const jwt of [await token({ common_name: "svc.access", sub: "" }), await token({ common_name: "svc.access" }), await token({ sub: "" }), await token({ sub: undefined })]) {
    assert.equal((await quiet(() => request({ jwt }))).status, 401);
  }
  assert.equal(calls.some(({ url }) => url.hostname === "api.github.com"), false);
});

test("rate limit is keyed by the verified identity, not the proxy IP", async () => {
  const keys = [];
  const e = { ...env, CHAT_LIMIT: { limit: async ({ key }) => { keys.push(key); return { success: true }; } } };
  assert.equal((await request({ e })).status, 200);
  assert.deepEqual(keys, ["repo-qa:trusted@example.com"]);
});
