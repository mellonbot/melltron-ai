// Static guards for the chat page's markup and CSS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
const css = read("app.css");
const html = read("index.html");

test("link preview names the desktop Ollama models", () => {
  const desc = html.match(/name="description" content="([^"]*)"/)?.[1] || "";
  assert.match(desc, /desktop Ollama models on the RTX 4060/);
  assert.match(html, /desktop Ollama/);
  assert.match(html, /RTX 4060/);
  assert.doesNotMatch(desc, /Raspberry Pi|LocalAI|Hailo/i);
  assert.doesNotMatch(html, /hailo/i);
});

test("public page has hub-style canonical, Open Graph, and Twitter tags", () => {
  assert.match(html, /<link rel="canonical" href="https:\/\/ai\.melltron\.build\/">/);
  assert.match(html, /<meta property="og:title" content="AI · melltron\.build lab">/);
  assert.match(html, /<meta property="og:description" content="AI — chat with the desktop Ollama models on the RTX 4060\.">/);
  assert.match(html, /<meta property="og:url" content="https:\/\/ai\.melltron\.build\/">/);
  assert.match(html, /<meta property="og:type" content="website">/);
  assert.match(html, /<meta name="twitter:card" content="summary">/);
  assert.match(html, /<meta name="twitter:title" content="AI · melltron\.build lab">/);
  assert.match(html, /<meta name="twitter:description" content="AI — chat with the desktop Ollama models on the RTX 4060\.">/);
  assert.doesNotMatch(html, /<script(?![^>]*\ssrc=)|<style[\s>]|\son[a-z]+=/i);
});

test("the lab index link is visible on the chat page", () => {
  assert.match(html, /<a class="crumb" href="https:\/\/melltron\.build\/lab\/">melltron\.build \/ lab<\/a>/);
  assert.doesNotMatch(css, /\.crumb[^{]*\{[^}]*display:\s*none/);
});

test("visitor errors name the machine that failed", () => {
  const js = read("app.js");
  assert.match(js, /LocalAI isn't running/);
  assert.match(js, /Ollama isn't running on it/);
  assert.match(js, /Pi · Ollama/);
  assert.doesNotMatch(js, /hailo/i);
  assert.doesNotMatch(js, /isn't connected to Ollama/);
  assert.doesNotMatch(js, /Ollama: /);
});

test("Hailo names are gone from the app, config, and docs", () => {
  const files = ["../wrangler.jsonc", "../README.md", "../src/api.js", "../public/app.js", "../public/index.html", "../test/api.test.js"];
  for (const f of files) {
    const text = readFileSync(new URL(f, import.meta.url), "utf8");
    assert.doesNotMatch(text, /hailo/i, f);
  }
});

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
