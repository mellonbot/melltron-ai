// Pinned to melltron.build/src/headers.js SECURITY_HEADERS.
// The root CI diffs the public AI repo directly. Private labs run this pin.
// Change the words in headers.js and in every pin together. Do not edit this
// object just to make a local copy pass.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SECURITY_HEADERS } from "../src/edge.js";

const EXPECTED = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; " +
    "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

test("security headers match melltron.build/src/headers.js", () => {
  assert.deepEqual(SECURITY_HEADERS, EXPECTED);
});
