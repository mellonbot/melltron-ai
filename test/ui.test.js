// Static guards for the chat page's markup and CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const css = read("app.css");
const html = read("index.html");

test("[hidden] wins over author display rules", () => {
  // .request { display: grid } once kept the access form on screen after access was granted.
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
});

test("composer placeholder fits one line; keyboard hint lives outside it", () => {
  const ph = html.match(/id="input"[^>]*placeholder="([^"]*)"/)?.[1];
  assert.ok(ph, "composer has a placeholder");
  assert.ok(ph.length <= 24, `placeholder too long for a phone: "${ph}"`);
  assert.doesNotMatch(ph, /enter/i);
  assert.match(html, /id="keys"/);
  assert.match(css, /@media \(pointer: coarse\)[^}]*\.composer \.keys \{ display: none; \}/);
});

test("touch inputs are 16px so iOS doesn't zoom on focus", () => {
  assert.match(css, /@media \(pointer: coarse\)[\s\S]*\.composer textarea[^{]*\{ font-size: 16px; \}/);
});
