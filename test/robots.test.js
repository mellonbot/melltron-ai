import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const robots = readFileSync(new URL("../public/robots.txt", import.meta.url), "utf8");

test("robots.txt is crawler directives, not a comment-only preamble", () => {
  assert.match(robots, /^User-agent: \*\nAllow: \/\nDisallow: \/admin\n\nSitemap: https:\/\/ai\.melltron\.build\/sitemap\.xml\n$/);
  assert.doesNotMatch(robots, /content signals|Cloudflare Managed/i);
  const directives = robots.split("\n").filter((line) => line && !line.startsWith("#"));
  assert.ok(directives.some((line) => line.startsWith("User-agent:")));
  assert.ok(directives.some((line) => line.startsWith("Allow:")));
  assert.ok(directives.some((line) => line.startsWith("Sitemap:")));
});

test("the sitemap lists the public page and the file robots.txt names", () => {
  const sitemap = readFileSync(new URL("../public/sitemap.xml", import.meta.url), "utf8");
  assert.match(sitemap, /<loc>https:\/\/ai\.melltron\.build\/<\/loc>/);
  assert.doesNotMatch(sitemap, /\/admin/);
  const named = robots.match(/^Sitemap: (\S+)/m)?.[1];
  assert.equal(named, "https://ai.melltron.build/sitemap.xml");
});
