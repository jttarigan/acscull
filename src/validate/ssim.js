// SPEC.md v0.2 §4.6 — SSIM per Wang et al. 2004.
//
// 11x11 Gaussian window (sigma=1.5), K1=0.01, K2=0.03, dynamic range L=255.
// Operates on RGBA8 buffers, computes SSIM over BT.709 luminance, then
// averages over the valid (non-border) region.

const KERNEL_SIZE = 11;
const HALF = (KERNEL_SIZE - 1) / 2; // 5
const SIGMA = 1.5;

const KERNEL = (() => {
  const k = new Float32Array(KERNEL_SIZE);
  let sum = 0;
  for (let i = 0; i < KERNEL_SIZE; i++) {
    const x = i - HALF;
    k[i] = Math.exp(-(x * x) / (2 * SIGMA * SIGMA));
    sum += k[i];
  }
  for (let i = 0; i < KERNEL_SIZE; i++) k[i] /= sum;
  return k;
})();

const C1 = (0.01 * 255) * (0.01 * 255);
const C2 = (0.03 * 255) * (0.03 * 255);

function ssim(rgbaA, rgbaB, w, h) {
  if (rgbaA.length !== w * h * 4 || rgbaB.length !== w * h * 4) {
    throw new Error('ssim: buffer length must be w*h*4');
  }
  if (w < KERNEL_SIZE || h < KERNEL_SIZE) {
    throw new Error('ssim: image must be at least ' + KERNEL_SIZE + 'x' + KERNEL_SIZE);
  }

  const n = w * h;
  const yA = new Float32Array(n);
  const yB = new Float32Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    yA[i] = 0.2126 * rgbaA[j] + 0.7152 * rgbaA[j + 1] + 0.0722 * rgbaA[j + 2];
    yB[i] = 0.2126 * rgbaB[j] + 0.7152 * rgbaB[j + 1] + 0.0722 * rgbaB[j + 2];
  }

  const yA2 = new Float32Array(n);
  const yB2 = new Float32Array(n);
  const yAB = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    yA2[i] = yA[i] * yA[i];
    yB2[i] = yB[i] * yB[i];
    yAB[i] = yA[i] * yB[i];
  }

  const muA = gaussianSmooth(yA, w, h);
  const muB = gaussianSmooth(yB, w, h);
  const sA2map = gaussianSmooth(yA2, w, h);
  const sB2map = gaussianSmooth(yB2, w, h);
  const sABmap = gaussianSmooth(yAB, w, h);

  let total = 0;
  let count = 0;
  for (let y = HALF; y < h - HALF; y++) {
    for (let x = HALF; x < w - HALF; x++) {
      const i = y * w + x;
      const muAi = muA[i];
      const muBi = muB[i];
      const muA2i = muAi * muAi;
      const muB2i = muBi * muBi;
      const sigA2 = sA2map[i] - muA2i;
      const sigB2 = sB2map[i] - muB2i;
      const sigAB = sABmap[i] - muAi * muBi;

      const num = (2 * muAi * muBi + C1) * (2 * sigAB + C2);
      const den = (muA2i + muB2i + C1) * (sigA2 + sigB2 + C2);
      total += num / den;
      count++;
    }
  }

  return count > 0 ? total / count : 0;
}

function gaussianSmooth(src, w, h) {
  const tmp = new Float32Array(w * h);
  // Horizontal pass with edge clamping
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < KERNEL_SIZE; k++) {
        let xx = x + k - HALF;
        if (xx < 0) xx = 0;
        else if (xx >= w) xx = w - 1;
        v += src[row + xx] * KERNEL[k];
      }
      tmp[row + x] = v;
    }
  }
  const out = new Float32Array(w * h);
  // Vertical pass with edge clamping
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 0;
      for (let k = 0; k < KERNEL_SIZE; k++) {
        let yy = y + k - HALF;
        if (yy < 0) yy = 0;
        else if (yy >= h) yy = h - 1;
        v += tmp[yy * w + x] * KERNEL[k];
      }
      out[y * w + x] = v;
    }
  }
  return out;
}

function maxAbsDiff(a, b) {
  if (a.length !== b.length) throw new Error('maxAbsDiff: length mismatch');
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

module.exports = { ssim, maxAbsDiff, KERNEL_SIZE, SIGMA };
