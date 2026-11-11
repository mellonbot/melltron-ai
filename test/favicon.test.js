import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROOT_PULSE, applyPulse, flashFor, pulseFor } from "../tools/pulse.mjs";

const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");

test("favicon passes the strict CSP (SMIL only, no inline style/script)", () => {
  assert.doesNotMatch(svg, /<style|<script|\sstyle=|on[a-z]+=/i);
  assert.match(svg, /<animate /);
});

test("pages link the favicon", () => {
  for (const f of ["index.html", "404.html"]) {
    assert.match(readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8"), /rel="icon" href="\/favicon\.svg"/, f);
  }
});

test("pulse colour is deterministic, valid, and never the root's", () => {
  for (const s of ["briefings", "part-tracker", "a1b", "zz-top"]) {
    const p = pulseFor(s);
    assert.equal(p, pulseFor(s));
    assert.match(p, /^#[0-9a-f]{6}$/);
    assert.notEqual(p, ROOT_PULSE);
  }
});

test("applyPulse swaps pulse and pad flash, refuses the root colour", () => {
  const out = applyPulse(svg, "#ff80c3");
  assert.ok(!out.includes(ROOT_PULSE));
  assert.ok(out.includes("#ff80c3") && out.includes(flashFor("#ff80c3")));
  assert.throws(() => applyPulse(svg, ROOT_PULSE));
  assert.throws(() => applyPulse(svg, "red"));
});
