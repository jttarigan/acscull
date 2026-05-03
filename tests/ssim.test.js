// Unit test for src/validate/ssim.js.
//
// Run: node tests/ssim.test.js
// Exit: 0 = pass, 1 = fail.

const path = require('path');
const { ssim, maxAbsDiff } = require(path.resolve(__dirname, '..', 'src', 'validate', 'ssim.js'));

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

function makeUniform(w, h, r, g, b, a) {
  const buf = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    buf[i * 4 + 0] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

function makeNoise(w, h, seed) {
  const buf = new Uint8Array(w * h * 4);
  let s = seed | 0;
  for (let i = 0; i < buf.length; i++) {
    s = (s * 1664525 + 1013904223) | 0;
    buf[i] = (s >>> 24) & 0xff;
  }
  return buf;
}

function addNoise(src, amplitude, seed) {
  const out = new Uint8Array(src.length);
  let s = seed | 0;
  for (let i = 0; i < src.length; i++) {
    s = (s * 1664525 + 1013904223) | 0;
    const n = ((s >>> 24) & 0xff) - 128;
    const v = src[i] + Math.round((n / 128) * amplitude);
    out[i] = Math.max(0, Math.min(255, v));
  }
  return out;
}

const W = 64;
const H = 64;

// Identity: SSIM(A, A) = 1
{
  const A = makeUniform(W, H, 100, 150, 200, 255);
  const s = ssim(A, A, W, H);
  check(Math.abs(s - 1) < 1e-5, `ssim(A,A) should be 1, got ${s}`);
  check(maxAbsDiff(A, A) === 0, 'maxAbsDiff(A,A) should be 0');
}

// Random + identity: structured noise vs itself = 1
{
  const A = makeNoise(W, H, 42);
  const s = ssim(A, A, W, H);
  check(Math.abs(s - 1) < 1e-5, `ssim(noise,noise) should be 1, got ${s}`);
}

// Black vs white: very different
{
  const black = makeUniform(W, H, 0, 0, 0, 255);
  const white = makeUniform(W, H, 255, 255, 255, 255);
  const s = ssim(black, white, W, H);
  check(s < 0.05, `ssim(black,white) should be near 0, got ${s}`);
  check(maxAbsDiff(black, white) === 255, `maxAbsDiff(black,white) should be 255, got ${maxAbsDiff(black, white)}`);
}

// Tiny noise: SSIM should remain very high
{
  const A = makeNoise(W, H, 7);
  const B = addNoise(A, 2, 99);
  const s = ssim(A, B, W, H);
  check(s > 0.97, `ssim with amplitude-2 noise should be > 0.97, got ${s}`);
  const md = maxAbsDiff(A, B);
  check(md > 0 && md <= 4, `maxAbsDiff with noise=2 should be small, got ${md}`);
}

// Substantial noise: SSIM lower but still positive
{
  const A = makeNoise(W, H, 7);
  const B = addNoise(A, 50, 99);
  const s = ssim(A, B, W, H);
  check(s < 0.95, `ssim with amplitude-50 noise should be < 0.95, got ${s}`);
  check(s > 0.1, `ssim with amplitude-50 noise should be > 0.1, got ${s}`);
}

// Symmetry: SSIM(A,B) === SSIM(B,A)
{
  const A = makeNoise(W, H, 1);
  const B = makeNoise(W, H, 2);
  const sAB = ssim(A, B, W, H);
  const sBA = ssim(B, A, W, H);
  check(Math.abs(sAB - sBA) < 1e-6, `SSIM should be symmetric, got ${sAB} vs ${sBA}`);
}

// Bounded
{
  const A = makeNoise(W, H, 17);
  const B = makeNoise(W, H, 18);
  const s = ssim(A, B, W, H);
  check(s >= -1 && s <= 1, `SSIM out of [-1,1], got ${s}`);
}

if (failures.length === 0) {
  console.log('ssim test: PASS');
  process.exit(0);
} else {
  console.log('ssim test: FAIL');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
