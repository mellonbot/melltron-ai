#!/usr/bin/env node
// Deploy verifier for ai.melltron.build. Same idea as melltron.build/tools/smoke.mjs:
// wait until the origin serves the committed public/ files, then check the edge
// policy in src/edge.js. /admin is behind Cloudflare Access, so a login redirect
// there is success; every other committed file must match byte for byte.
//
//   node tools/smoke.mjs <base-url> [--prod] [--wait <seconds>] [--no-browser]
//
// Expected bytes and headers come from this repo, not from constants copied here.

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, appendFileSync } from "node:fs";
import { join, relative, extname, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import tls from "node:tls";
import { SECURITY_HEADERS } from "../src/edge.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC = join(ROOT, "public");
const EDGE = readFileSync(join(ROOT, "src/edge.js"), "utf8");
const CACHE_HTML = "public, max-age=300, must-revalidate";
const CACHE_IMMUTABLE = "public, max-age=31536000, immutable";
if (!EDGE.includes(CACHE_HTML) || !EDGE.includes(CACHE_IMMUTABLE)) {
  console.error("cache strings in tools/smoke.mjs drifted from src/edge.js");
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const BASE = (argv.find((a) => /^https?:\/\//.test(a)) || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("usage: node tools/smoke.mjs <base-url> [--prod] [--wait <s>] [--no-browser]");
  process.exit(2);
}
const PROD = flag("--prod");
const WAIT = Number(opt("--wait", "0"));
const BROWSER = !flag("--no-browser");
const BUST = `verify=${(process.env.GITHUB_SHA || String(Date.now())).slice(0, 12)}`;
const HOST = new URL(BASE).host;

const results = [];
const pass = (area, detail) => results.push({ area, status: "pass", detail });
const fail = (area, detail) => results.push({ area, status: "fail", detail });
const warn = (area, detail) => results.push({ area, status: "warn", detail });

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

function urlPathFor(rel) {
  const p = "/" + rel.split(sep).join("/");
  if (p.endsWith("/index.html")) return p.slice(0, -"index.html".length);
  if (p.endsWith(".html")) return p.slice(0, -".html".length);
  return p;
}

const inventory = walk(PUBLIC)
  .map((abs) => {
    const rel = relative(PUBLIC, abs);
    return { rel, path: urlPathFor(rel), hash: sha(readFileSync(abs)), abs };
  })
  .filter((f) => f.rel !== "404.html");
const known = new Set(inventory.map((f) => f.path));
const NOT_FOUND_HASH = sha(readFileSync(join(PUBLIC, "404.html")));
const FINGERPRINTED = /\.[0-9a-f]{8,}\.[a-z0-9]+$/;
const gatedPath = (path) => path === "/admin" || path.startsWith("/admin/");

const TYPES = {
  "": "text/html", ".html": "text/html", ".css": "text/css", ".js": "javascript",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/", ".webp": "image/webp",
};
const typeFor = (path) => (path.endsWith("/") ? "text/html" : TYPES[extname(path)]);

async function get(path, init = {}) {
  const joiner = path.includes("?") ? "&" : "?";
  return fetch(BASE + path + joiner + BUST, { redirect: "manual", ...init });
}

function accessRedirect(res) {
  return res?.status === 302 && (res.headers.get("location") || "").includes("cloudflareaccess.com");
}

function checkPolicy(path, res) {
  const errs = [];
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    const got = res.headers.get(k);
    if (got !== v) errs.push(`${k}: ${got === null ? "missing" : `"${got}"`}`);
  }
  const ct = res.headers.get("content-type") || "";
  const cc = res.headers.get("cache-control");
  if (FINGERPRINTED.test(path) && cc !== CACHE_IMMUTABLE) errs.push(`Cache-Control: "${cc}" (want immutable)`);
  if (ct.includes("text/html") && cc !== CACHE_HTML) errs.push(`Cache-Control: "${cc}" (want ${CACHE_HTML})`);
  return errs.length ? `${path} — ${errs.join("; ")}` : null;
}

async function fetchAll() {
  const out = [];
  const queue = [...inventory];
  const workers = Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const f = queue.shift();
      try {
        const res = await get(f.path);
        const body = Buffer.from(await res.arrayBuffer());
        out.push({ f, res, hash: sha(body), gated: gatedPath(f.path) && accessRedirect(res) });
      } catch (e) {
        out.push({ f, res: null, err: String(e.cause?.code || e.message), gated: false });
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const mismatches = (rows) =>
  rows.filter((r) => {
    if (r.gated) return false;
    return !r.res || r.res.status !== 200 || r.hash !== r.f.hash;
  });

let rows = await fetchAll();
const started = Date.now();
while (WAIT && mismatches(rows).length && Date.now() - started < WAIT * 1000) {
  const m = mismatches(rows).length;
  console.log(`waiting for deploy: ${m}/${rows.length} paths differ from public/ (${Math.round((Date.now() - started) / 1000)}s)`);
  await new Promise((r) => setTimeout(r, 15000));
  rows = await fetchAll();
}
const waited = Math.round((Date.now() - started) / 1000);
const bad = mismatches(rows);
if (bad.length) {
  for (const r of bad.slice(0, 20)) {
    const why = !r.res ? r.err : r.res.status !== 200 ? `HTTP ${r.res.status}` : "bytes differ from public/";
    fail("content", `${r.f.path} — ${why}`);
  }
  if (bad.length > 20) fail("content", `…and ${bad.length - 20} more`);
} else {
  const gated = rows.filter((r) => r.gated).length;
  pass("content", `${rows.length - gated} paths byte-identical to public/${gated ? `, ${gated} behind Access` : ""}${WAIT ? ` (deploy landed after ${waited}s)` : ""}`);
}

const policyErrs = [];
const typeErrs = [];
for (const r of rows.filter((r) => r.res && !r.gated)) {
  const e = checkPolicy(r.f.path, r.res);
  if (e) policyErrs.push(e);
  const want = typeFor(r.f.path);
  const ct = r.res.headers.get("content-type") || "";
  if (want && r.res.status === 200 && !ct.includes(want)) typeErrs.push(`${r.f.path} — content-type "${ct}" (want ${want})`);
}
policyErrs.slice(0, 10).forEach((e) => fail("headers", e));
if (!policyErrs.length) pass("headers", `security headers match src/edge.js on ${rows.filter((r) => r.res && !r.gated).length} responses`);
typeErrs.slice(0, 10).forEach((e) => fail("content-type", e));
if (!typeErrs.length) pass("content-type", "MIME types as expected");

const admin = rows.filter((r) => gatedPath(r.f.path));
if (admin.length && admin.every((r) => r.gated || (r.res?.status === 200 && r.hash === r.f.hash))) {
  pass("admin", admin.some((r) => r.gated) ? "Access login still in front of /admin" : "/admin served the committed files");
} else if (admin.length) {
  fail("admin", "/admin was neither the committed file nor an Access login redirect");
}

{
  const path = "/__verify-missing-" + BUST.slice(7);
  const res = await get(path);
  const body = Buffer.from(await res.arrayBuffer());
  const errs = [];
  if (res.status !== 404) errs.push(`status ${res.status}`);
  if (sha(body) !== NOT_FOUND_HASH) errs.push("body is not public/404.html");
  const pol = checkPolicy(path, res);
  if (pol) errs.push(pol);
  errs.length ? fail("404", errs.join("; ")) : pass("404", "unknown path → public/404.html with the edge headers");
}

{
  const res = await get("/_health");
  let body = {};
  try { body = await res.json(); } catch { /* reported below */ }
  const errs = [];
  if (res.status !== 200) errs.push(`status ${res.status}`);
  if (body.app !== "ai") errs.push(`app ${JSON.stringify(body.app)}`);
  if (!body.version || !("deployed" in body)) errs.push("missing version or deployed");
  if (res.headers.get("cache-control") !== "no-store") errs.push(`cache ${res.headers.get("cache-control")}`);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (res.headers.get(k) !== v) errs.push(`${k} mismatch`);
  }
  errs.length
    ? fail("health", errs.join("; "))
    : pass("health", `app=ai version=${body.version} deployed=${body.deployed ?? "null"}`);
}

{
  const broken = [];
  let checked = 0;
  for (const f of inventory.filter((f) => f.rel.endsWith(".html"))) {
    const html = readFileSync(f.abs, "utf8");
    const pageUrl = new URL(f.path, BASE);
    for (const m of html.matchAll(/\s(?:href|src)="([^"]+)"/g)) {
      const raw = m[1];
      if (/^(mailto:|tel:|data:|#|javascript:)/.test(raw)) continue;
      const u = new URL(raw, pageUrl);
      if (u.host !== HOST) continue;
      checked++;
      const p = u.pathname;
      if (!(known.has(p) || known.has(p + "/") || (p.endsWith("/") && known.has(p.slice(0, -1)))))
        broken.push(`${f.path} → ${raw}`);
    }
  }
  broken.slice(0, 15).forEach((b) => fail("links", b));
  if (!broken.length) pass("links", `${checked} same-origin links resolve to committed files`);
}

if (PROD) {
  const base = new URL(BASE);
  try {
    const res = await fetch(`http://${base.host}/`, { redirect: "manual" });
    const loc = res.headers.get("location") || "";
    if ([301, 302, 307, 308].includes(res.status) && loc.startsWith("https://")) pass("http", `http → https (${res.status})`);
    else warn("http", `http:// served ${res.status} without upgrading`);
  } catch (e) {
    warn("http", String(e.cause?.code || e.message));
  }

  await new Promise((resolve) => {
    const s = tls.connect({ host: base.hostname, port: 443, servername: base.hostname }, () => {
      const days = Math.floor((new Date(s.getPeerCertificate().valid_to) - Date.now()) / 864e5);
      if (days < 7) fail("tls", `certificate expires in ${days} days`);
      else if (days < 21) warn("tls", `certificate expires in ${days} days`);
      else pass("tls", `certificate valid ${days} more days`);
      s.end();
      resolve();
    });
    s.on("error", (e) => (fail("tls", e.message), resolve()));
  });

  if (process.env.WORKERS_DEV_URL) {
    try {
      const res = await fetch(process.env.WORKERS_DEV_URL, { redirect: "manual" });
      res.status === 200
        ? fail("workers.dev", `${process.env.WORKERS_DEV_URL} serves 200 — production has a second public origin`)
        : pass("workers.dev", `production workers.dev URL off (${res.status})`);
    } catch {
      pass("workers.dev", "production workers.dev URL off (no route)");
    }
  }
}

if (BROWSER) {
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || undefined,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
  const pages = inventory.filter((f) => typeFor(f.path) === "text/html" && !gatedPath(f.path));
  let clean = 0;
  for (const f of pages) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const problems = [];
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (e) =>
        console.error(`CSP violation: ${e.violatedDirective} blocked ${e.blockedURI || "inline"}`));
    });
    page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(`uncaught: ${e.message}`));
    page.on("requestfailed", (r) => problems.push(`request failed: ${r.url()} (${r.failure()?.errorText})`));
    page.on("response", (r) => {
      if (r.url().startsWith(BASE) && r.status() >= 400) problems.push(`${r.status()} ${r.url()}`);
    });
    try {
      await page.goto(BASE + f.path, { waitUntil: "load", timeout: 30000 });
      await page.waitForTimeout(500);
    } catch (e) {
      problems.push(`navigation: ${e.message.split("\n")[0]}`);
    }
    await ctx.close();
    const uniq = [...new Set(problems)].filter((p) => !p.includes("static.cloudflareinsights.com"));
    if (uniq.length) uniq.slice(0, 5).forEach((p) => fail("browser", `${f.path} — ${p}`));
    else clean++;
  }
  await browser.close();
  if (clean === pages.length) pass("browser", `${pages.length} public pages: zero CSP violations, script errors or failed requests`);
}

const icon = { pass: "✅", fail: "❌", warn: "⚠️" };
const failed = results.filter((r) => r.status === "fail");
const header = `### Deploy verification — ${BASE}\n\n${failed.length ? `**${failed.length} failure(s)**` : "**All checks passed**"}\n\n| | Check | Detail |\n|---|---|---|\n`;
const table = results.map((r) => `| ${icon[r.status]} | ${r.area} | ${r.detail.replace(/[\\|\r\n]/g, (c) => (c === "\n" || c === "\r" ? " " : `\\${c}`))} |`).join("\n");
for (const r of results) {
  const line = `${r.status.toUpperCase().padEnd(4)} ${r.area}: ${r.detail}`;
  if (process.env.GITHUB_ACTIONS && r.status !== "pass") console.log(`::${r.status === "fail" ? "error" : "warning"} title=${r.area}::${r.detail}`);
  else console.log(line);
}
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, header + table + "\n");
process.exit(failed.length ? 1 : 0);
