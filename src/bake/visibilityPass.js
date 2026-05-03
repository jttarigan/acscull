// SPEC.md v0.2 §2.5-2.6 — K x P visibility sampling.
//
// For each (camera, pose), poses the skeleton via applyPose(), renders the
// baking mesh into an R32UI target, reads back, and ORs every observed
// triangle ID into a bitset. Returns the bitset and a bit-count.

const THREE = require('three');

function runVisibilityPass(opts) {
  const {
    renderer,
    scene,
    bakeMesh,
    cameras,
    poses,
    applyPose,
    triangleCount,
    renderTarget,
    onProgress,
  } = opts;

  const W = renderTarget.width;
  const H = renderTarget.height;
  const bitset = new Uint32Array(Math.ceil(triangleCount / 32));
  const readBuf = new Uint32Array(W * H);
  const gl = renderer.getContext();
  const zeroU32 = new Uint32Array([0, 0, 0, 0]);

  const prevAutoClear = renderer.autoClear;
  renderer.autoClear = false;

  let sampleIdx = 0;
  const total = cameras.length * poses.length;
  const t0 = Date.now();

  for (let p = 0; p < poses.length; p++) {
    const pose = poses[p];
    applyPose(pose);
    bakeMesh.skeleton.update();

    for (let k = 0; k < cameras.length; k++) {
      const cam = cameras[k];

      renderer.setRenderTarget(renderTarget);
      gl.clearBufferuiv(gl.COLOR, 0, zeroU32);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(renderTarget, 0, 0, W, H, readBuf);

      for (let i = 0; i < readBuf.length; i++) {
        const v = readBuf[i];
        if (v !== 0) {
          const triId = v - 1;
          bitset[triId >>> 5] |= 1 << (triId & 31);
        }
      }

      sampleIdx++;
      if (onProgress && (sampleIdx % 32 === 0 || sampleIdx === total)) {
        onProgress({
          sampleIdx,
          total,
          trianglesSeen: popcountAll(bitset),
          elapsedSeconds: (Date.now() - t0) / 1000,
        });
      }
    }
  }

  renderer.setRenderTarget(null);
  renderer.autoClear = prevAutoClear;

  return {
    bitset,
    trianglesSeen: popcountAll(bitset),
    elapsedSeconds: (Date.now() - t0) / 1000,
  };
}

function popcountAll(bitset) {
  let seen = 0;
  for (let b = 0; b < bitset.length; b++) {
    let x = bitset[b];
    while (x) { x &= x - 1; seen++; }
  }
  return seen;
}

module.exports = { runVisibilityPass };
