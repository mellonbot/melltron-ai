// Edge contract shared by every *.melltron.build app.
// Source of truth: melltron.build/src/headers.js. Keep the headers identical so
// the whole domain has one security posture; if you change one, change both.

export const SECURITY_HEADERS = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data: https:; style-src 'self'; script-src 'self'; " +
    "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

// name.0123abcd.ext — only content-hashed files are safe to cache forever.
const FINGERPRINTED = /\.[0-9a-f]{8,}\.[a-z0-9]+$/;

// isAsset: response came from env.ASSETS. Cache policy applies only there —
// the asset server sets its own Cache-Control (max-age=0), so override it.
// Worker-generated responses (api, health) keep whatever they set.
export function finalize(res, pathname, isAsset) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) out.headers.set(k, v);
  if (!isAsset) return out;
  const type = out.headers.get("content-type") || "";
  if (FINGERPRINTED.test(pathname)) {
    out.headers.set("Cache-Control", "public, max-age=31536000, immutable");
  } else if (type.includes("text/html")) {
    out.headers.set("Cache-Control", "public, max-age=300, must-revalidate");
  }
  return out;
}
