// Runs on plain Node (>=22 has fetch/Request/Response). No Workers runtime needed
// for the edge contract; use `npm run dev` for anything that touches real bindings.
import { test } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.js";
import { SECURITY_HEADERS } from "../src/edge.js";

// Mirrors the real asset server, which sends its own Cache-Control on everything.
const ASSET_CC = "public, max-age=0, must-revalidate";
const asset = (body, type, status = 200) =>
  new Response(body, { status, headers: { "content-type": type, "cache-control": ASSET_CC } });
const ASSETS = {
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/") return asset("<h1>hi</h1>", "text/html");
    if (pathname === "/app.3f2a9c1d.css") return asset("x", "text/css");
    if (pathname === "/app.css") return asset("x", "text/css");
    return asset("nf", "text/html", 404);
  },
};
const env = { ASSETS, CF_VERSION_METADATA: { id: "v-123", tag: "", timestamp: "2026-11-02T00:00:00Z" } };
const get = (path, init) => worker.fetch(new Request(`https://x.melltron.build${path}`, init), env, {});

test("security headers on every response type", async () => {
  for (const p of ["/", "/nope", "/api/ping", "/api/nope", "/_health"]) {
    const res = await get(p);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) assert.equal(res.headers.get(k), v, `${p} ${k}`);
  }
});

test("cache policy", async () => {
  assert.match((await get("/")).headers.get("cache-control"), /max-age=300/);
  assert.match((await get("/app.3f2a9c1d.css")).headers.get("cache-control"), /immutable/);
  assert.equal((await get("/app.css")).headers.get("cache-control"), ASSET_CC, "unhashed assets must not be immutable");
  assert.equal((await get("/api/ping")).headers.get("cache-control"), "no-store");
});

test("/_health reports deployed version", async () => {
  const body = await (await get("/_health")).json();
  assert.equal(body.version, "v-123");
});

test("api routing", async () => {
  assert.equal((await (await get("/api/ping")).json()).ok, true);
  assert.equal((await get("/api/nope")).status, 404);
  assert.equal((await get("/api/ping", { method: "POST" })).status, 404);
});

test("handler errors become 500 with headers intact", async () => {
  const bad = { ...env, ASSETS: { fetch: () => { throw new Error("boom"); } } };
  const orig = console.error; console.error = () => {};
  const res = await worker.fetch(new Request("https://x.melltron.build/"), bad, {});
  console.error = orig;
  assert.equal(res.status, 500);
  assert.ok(res.headers.get("Content-Security-Policy"));
});
