#!/usr/bin/env node
// One-time setup after "Use this template":
//   node tools/init.mjs <subdomain> "<Display Name>" [--pulse #rrggbb]
// Replaces the template-app / Template App placeholders, sets the favicon's pulse colour
// (derived from the subdomain unless --pulse is given), deletes the .template marker,
// and prints the entry to add to melltron.build/content/lab.json.
//
//   node tools/init.mjs --verify   (CI) fail if an initialised repo still has placeholders
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ROOT_PULSE, applyPulse, pulseFor } from "./pulse.mjs";

const FILES = ["wrangler.jsonc", "package.json", "package-lock.json", "src/index.js", "public/index.html", "public/404.html"];
const MARKER = ".template";
const ICON = "public/favicon.svg";
const SLUG = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
const RESERVED = new Set(["template-app", "www", "api", "mail", "lab", "admin", "static", "cdn"]);

const argv = process.argv.slice(2);
const pi = argv.indexOf("--pulse");
const pulseArg = pi >= 0 ? argv.splice(pi, 2)[1] : undefined;
const [arg, ...rest] = argv;

if (arg === "--verify") {
  if (existsSync(MARKER)) process.exit(0); // the template itself
  const left = FILES.filter((f) => /template-app|Template App/.test(readFileSync(f, "utf8")));
  if (readFileSync(ICON, "utf8").includes(ROOT_PULSE)) left.push(`${ICON} (root pulse colour)`);
  if (left.length) {
    console.error(`placeholders remain in: ${left.join(", ")} — run: node tools/init.mjs <subdomain> "<Name>"`);
    process.exit(1);
  }
  process.exit(0);
}

const slug = arg;
const name = rest.join(" ").trim() || slug;
if (!existsSync(MARKER)) exit("already initialised (no .template marker)");
if (!slug || !SLUG.test(slug)) exit("subdomain must be 3-32 chars: lowercase letters, digits, hyphens");
if (RESERVED.has(slug)) exit(`"${slug}" is reserved`);
if (/[<>"&]/.test(name)) exit("display name must not contain < > \" &");
const pulse = (pulseArg ?? pulseFor(slug)).toLowerCase();
let icon;
try {
  icon = applyPulse(readFileSync(ICON, "utf8"), pulse);
} catch (e) {
  exit(e.message);
}

for (const f of FILES) {
  writeFileSync(f, readFileSync(f, "utf8").replaceAll("Template App", name).replaceAll("template-app", slug));
}
writeFileSync(ICON, icon);
rmSync(MARKER);

console.log(`initialised ${slug}.melltron.build (Worker: lab-${slug}, favicon pulse ${pulse})

Next:
  1. npm ci && npm test && npm run dev
  2. Commit + push, then connect the repo in Cloudflare (Workers → Create → Import repo).
  3. Register in melltron.build/content/lab.json (append, never reorder):
     { "name": ${JSON.stringify(name)}, "subdomain": "${slug}", "status": "building", "summary": "One line." }`);

function exit(msg) {
  console.error(msg);
  process.exit(1);
}
