import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { ROOT_PULSE, applyPulse, flashFor, pulseFor } from "../tools/pulse.mjs";

const svg = readFileSync(new URL("../public/favicon.svg", import.meta.url), "utf8");

test("favicon passes the strict CSP (SMIL only, no inline style/script)", () => {
  assert.doesNotMatch(svg, /<style|<script|\sstyle=|on[a-z]+=/i);
  assert.match(svg, /<animate /);
});

test("pages link the favicon", () => {
  for (const f of ["index.html", "404.html", "admin/index.html"]) {
    const html = readFileSync(new URL(`../public/${f}`, import.meta.url), "utf8");
    assert.match(html, /rel="icon" href="\/favicon\.ico" sizes="48x48"/, f);
    assert.match(html, /rel="icon" href="\/favicon\.svg" type="image\/svg\+xml"/, f);
  }
});

test("favicon.ico is the still frame of the SVG mark", () => {
  const ico = readFileSync(new URL("../public/favicon.ico", import.meta.url));
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  const count = ico.readUInt16LE(4);
  const sizes = [];
  let png32;
  for (let i = 0; i < count; i++) {
    const o = 6 + i * 16;
    const w = ico[o] || 256;
    const h = ico[o + 1] || 256;
    const size = ico.readUInt32LE(o + 8);
    const offset = ico.readUInt32LE(o + 12);
    const png = ico.subarray(offset, offset + size);
    assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", `${w}x${h} is a PNG`);
    sizes.push(`${w}x${h}`);
    if (w === 32 && h === 32) png32 = png;
  }
  assert.deepEqual(sizes, ["16x16", "32x32", "48x48"]);
  const px = pngPixels(png32);
  // 32px is 1:1 with the 32 viewBox. Plate, left stem, left pad.
  assert.ok(near(px(3, 16), [0x08, 0x13, 0x0f], 24), `plate ${px(3, 16)}`);
  assert.ok(near(px(8, 16), [0x2c, 0x7a, 0x58], 48), `trace ${px(8, 16)}`);
  assert.ok(near(px(8, 25), [0xd6, 0xa6, 0x3c], 48), `pad ${px(8, 25)}`);
});

function near(got, want, tol) {
  return got && want.every((c, i) => Math.abs(c - got[i]) <= tol);
}

// Enough of a PNG decoder to sample the still-frame colours. RGBA or RGB, 8-bit, non-interlaced.
function pngPixels(png) {
  const view = Buffer.from(png);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < view.length) {
    const len = view.readUInt32BE(pos);
    const type = view.subarray(pos + 4, pos + 8).toString("ascii");
    const data = view.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8-bit png");
      colorType = data[9];
      assert.equal(data[12], 0, "non-interlaced png");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") break;
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  assert.ok(bpp, `color type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const rows = [];
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    const row = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    const prev = rows[y - 1];
    for (let i = 0; i < stride; i++) {
      const left = i >= bpp ? row[i - bpp] : 0;
      const up = prev ? prev[i] : 0;
      const ul = prev && i >= bpp ? prev[i - bpp] : 0;
      if (filter === 1) row[i] = (row[i] + left) & 255;
      else if (filter === 2) row[i] = (row[i] + up) & 255;
      else if (filter === 3) row[i] = (row[i] + ((left + up) >> 1)) & 255;
      else if (filter === 4) {
        const pa = Math.abs(up - ul);
        const pb = Math.abs(left - ul);
        const pc = Math.abs(left + up - 2 * ul);
        const pr = pa <= pb && pa <= pc ? left : pb <= pc ? up : ul;
        row[i] = (row[i] + pr) & 255;
      }
    }
    rows.push(row);
  }
  return (x, y) => {
    const row = rows[y];
    const i = x * bpp;
    return [row[i], row[i + 1], row[i + 2]];
  };
}

test("pulse colour is deterministic, valid, and never the root's", () => {
  for (const s of ["briefings", "part-tracker", "a1b", "zz-top"]) {
    const p = pulseFor(s);
    assert.equal(p, pulseFor(s));
    assert.match(p, /^#[0-9a-f]{6}$/);
    assert.notEqual(p, ROOT_PULSE);
  }
});

// Only meaningful on the template itself: after init the root pulse is gone from favicon.svg.
const isTemplate = existsSync(new URL("../.template", import.meta.url));
test("applyPulse swaps pulse and pad flash, refuses the root colour", { skip: !isTemplate && "initialised app" }, () => {
  const out = applyPulse(svg, "#ff80c3");
  assert.ok(!out.includes(ROOT_PULSE));
  assert.ok(out.includes("#ff80c3") && out.includes(flashFor("#ff80c3")));
  assert.throws(() => applyPulse(svg, ROOT_PULSE));
  assert.throws(() => applyPulse(svg, "red"));
});
