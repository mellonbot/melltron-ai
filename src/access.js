// Verifies the Cloudflare Access JWT on every API call.
//
// Access in front of ai.melltron.build is the primary gate, but it only covers that
// hostname: a Workers preview URL serves the same code with no Access in front of it.
// So the Worker checks the token itself and fails closed when Access isn't configured.
//
// env.ACCESS_TEAM_DOMAIN  e.g. "mellon.cloudflareaccess.com"
// env.ACCESS_AUD          the Access application's Audience (AUD) tag

const CERT_TTL_MS = 60 * 60 * 1000;
let certCache = { team: null, at: 0, keys: new Map() };

const b64urlBytes = (s) => {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(pad), (c) => c.charCodeAt(0));
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function keyFor(team, kid, fetchImpl) {
  const fresh = certCache.team === team && Date.now() - certCache.at < CERT_TTL_MS;
  if (fresh && certCache.keys.has(kid)) return certCache.keys.get(kid);
  // Unknown kid on a fresh cache may mean a key rotation: refetch once.
  const res = await fetchImpl(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`access certs: HTTP ${res.status}`);
  const { keys = [] } = await res.json();
  const map = new Map();
  for (const jwk of keys) {
    if (jwk.kty !== "RSA" || !jwk.kid) continue;
    const { kid: id, kty, n, e } = jwk;
    map.set(id, await crypto.subtle.importKey("jwk", { kty, n, e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  certCache = { team, at: Date.now(), keys: map };
  return map.get(kid) ?? null;
}

// -> { ok: true, email } | { ok: false, status, error }
export async function verifyAccess(request, env, fetchImpl = fetch) {
  const team = (env.ACCESS_TEAM_DOMAIN || "").trim();
  const aud = (env.ACCESS_AUD || "").trim();
  if (!team || !aud) return { ok: false, status: 503, error: "access_not_configured" };

  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return { ok: false, status: 401, error: "unauthenticated" };

  try {
    const [h, p, sig] = token.split(".");
    if (!h || !p || !sig) throw new Error("malformed");
    const header = b64urlJson(h);
    const claims = b64urlJson(p);
    if (header.alg !== "RS256" || !header.kid) throw new Error("alg");

    const key = await keyFor(team, header.kid, fetchImpl);
    if (!key) throw new Error("unknown kid");
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(sig), new TextEncoder().encode(`${h}.${p}`));
    if (!valid) throw new Error("signature");

    const now = Math.floor(Date.now() / 1000);
    const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== `https://${team}`) throw new Error("iss");
    if (!auds.includes(aud)) throw new Error("aud");
    if (typeof claims.exp !== "number" || claims.exp <= now) throw new Error("expired");
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) throw new Error("nbf");

    return { ok: true, email: claims.email ?? null };
  } catch (err) {
    console.warn(JSON.stringify({ access: "rejected", reason: String(err?.message || err) }));
    return { ok: false, status: 401, error: "unauthenticated" };
  }
}

// Test hook.
export const _resetAccessCache = () => {
  certCache = { team: null, at: 0, keys: new Map() };
};
