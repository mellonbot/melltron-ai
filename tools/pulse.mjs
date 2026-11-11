// Favicon identity for lab apps. Every *.melltron.build app shares the root's
// circuit-board M (geometry source of truth: melltron.build/static/favicon.svg);
// only the current-pulse colour changes, so tabs read as one family but stay distinct.
//
// The colour is derived from the subdomain (deterministic, no state to keep), and
// steers clear of the root's cyan, the trace greens and the gold pads. Override with init --pulse.
import { createHash } from "node:crypto";

export const ROOT_PULSE = "#8ff9ff"; // root site — reserved, never used by a lab app
export const ROOT_FLASH = "#c8ffff"; // pad flash = pulse mixed 50% with white

// Hue bands to avoid: the gold pads (≈40°), and greens through the root cyan (≈183°) —
// greens vanish against the green traces, cyan is the root's.
const BLOCKED = [[25, 60], [95, 213]];
const OPEN = 360 - BLOCKED.reduce((n, [a, b]) => n + (b - a), 0);

export function pulseFor(slug) {
  let h = createHash("sha256").update(slug).digest().readUInt16BE(0) % OPEN;
  for (const [a, b] of [...BLOCKED].sort((x, y) => x[0] - y[0])) if (h >= a) h += b - a;
  return hsl(h, 100, 75);
}

export function flashFor(hex) {
  return "#" + [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16);
    return Math.round((c + 255) / 2).toString(16).padStart(2, "0");
  }).join("");
}

export function applyPulse(svg, hex) {
  if (!/^#[0-9a-f]{6}$/.test(hex)) throw new Error(`pulse must be #rrggbb lowercase, got ${hex}`);
  if (hex === ROOT_PULSE) throw new Error("that is the root site's pulse colour");
  if (!svg.includes(ROOT_PULSE)) throw new Error("favicon.svg has no template pulse colour (already set?)");
  return svg.replaceAll(ROOT_PULSE, hex).replaceAll(ROOT_FLASH, flashFor(hex));
}

function hsl(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return "#" + [0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, "0")).join("");
}
