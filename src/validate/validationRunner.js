// SPEC.md v0.2 §4.3-§4.5 — validation orchestration.
//
// Loads original + reduced GLBs, renders each from the same held-out cameras
// with shared lighting at t=0 of the first animation, computes SSIM and
// max-channel-abs-diff per camera, writes per-camera CSVs and a summary JSON.

const THREE = require('three');
const fs = require('fs');
const path = require('path');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');

const { ssim, maxAbsDiff } = require(path.resolve(__dirname, 'ssim.js'));
const {
  sampleHeldOutCameras,
  sampleAdversarialCameras,
} = require(path.resolve(__dirname, 'heldOutCameras.js'));

const HELD_OUT_COUNT = 128;

async function runValidation(opts) {
  const { renderer, originalPath, reducedPath, acs, outDir, onProgress } = opts;

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  console.log('Loading original GLB: ' + originalPath);
  const orig = await loadGLB(originalPath);
  console.log('Loading reduced GLB:  ' + reducedPath);
  const reduced = await loadGLB(reducedPath);

  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xffffff, 0.9);
  key.position.set(3, 5, 4);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xffffff, 0.35);
  fill.position.set(-4, 2, -3);
  scene.add(fill);

  scene.add(orig.scene);
  scene.add(reduced.scene);

  poseFirstAnimT0(orig);
  poseFirstAnimT0(reduced);

  const W = acs.render_resolution[0];
  const H = acs.render_resolution[1];
  const rt = new THREE.WebGLRenderTarget(W, H, {
    type: THREE.UnsignedByteType,
    format: THREE.RGBAFormat,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
    depthBuffer: true,
  });
  const bufA = new Uint8Array(W * H * 4);
  const bufB = new Uint8Array(W * H * 4);

  const stats = countMeshes(orig.scene, reduced.scene);

  function processCameras(cams, label) {
    const rows = [];
    const t0 = Date.now();
    for (let i = 0; i < cams.length; i++) {
      const cam = cams[i];

      orig.scene.visible = true;
      reduced.scene.visible = false;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, bufA);

      orig.scene.visible = false;
      reduced.scene.visible = true;
      renderer.setRenderTarget(rt);
      renderer.render(scene, cam);
      renderer.readRenderTargetPixels(rt, 0, 0, W, H, bufB);

      const s = ssim(bufA, bufB, W, H);
      const md = maxAbsDiff(bufA, bufB);

      rows.push({
        camera_index: i,
        pitch_deg: round6(cam.userData.acsSample.pitchDeg),
        yaw_deg: round6(cam.userData.acsSample.yawDeg),
        distance: round6(cam.userData.acsSample.dist),
        ssim: round6(s),
        max_abs_diff: md,
      });

      if (onProgress && ((i + 1) % 16 === 0 || i === cams.length - 1)) {
        onProgress({
          label,
          done: i + 1,
          total: cams.length,
          ssim: s,
          maxAbsDiff: md,
          elapsedSeconds: (Date.now() - t0) / 1000,
        });
      }
    }
    return rows;
  }

  console.log('In-ACS validation: ' + HELD_OUT_COUNT + ' cameras...');
  const inAcsRows = processCameras(
    sampleHeldOutCameras(acs, HELD_OUT_COUNT),
    'in-acs'
  );
  writeCSV(path.join(outDir, 'validation_in_acs.csv'), inAcsRows);

  console.log('Adversarial validation: ' + HELD_OUT_COUNT + ' cameras...');
  const advRows = processCameras(
    sampleAdversarialCameras(acs, HELD_OUT_COUNT),
    'adversarial'
  );
  writeCSV(path.join(outDir, 'validation_adversarial.csv'), advRows);

  const summary = {
    original_path: originalPath,
    reduced_path: reducedPath,
    acs_summary: {
      pitch: [acs.pitch_min_deg, acs.pitch_max_deg],
      yaw: [acs.yaw_min_deg, acs.yaw_max_deg],
      distance: [acs.distance_min, acs.distance_max],
      fov: acs.horizontal_fov_deg,
      aspect: acs.aspect_ratio,
    },
    counts: stats,
    held_out_count: HELD_OUT_COUNT,
    in_acs: computeStats(inAcsRows),
    adversarial: computeStats(advRows),
    timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(
    path.join(outDir, 'validation_summary.json'),
    JSON.stringify(summary, null, 2),
    'utf-8'
  );

  rt.dispose();
  return summary;
}

function loadGLB(filepath) {
  return new Promise((res, rej) => {
    const buf = fs.readFileSync(filepath);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const loader = new GLTFLoader();
    loader.parse(ab, '', res, rej);
  });
}

function poseFirstAnimT0(gltf) {
  if (!gltf.animations || gltf.animations.length === 0) {
    gltf.scene.updateMatrixWorld(true);
    return;
  }
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(gltf.animations[0]);
  action.play();
  mixer.setTime(0);
  gltf.scene.updateMatrixWorld(true);
}

function countMeshes(origScene, reducedScene) {
  // GLTFLoader can produce multiple Mesh objects sharing the same underlying
  // position attribute (one per glTF primitive / group). Dedupe by attribute
  // reference so vertexCount reflects unique vertices, not per-primitive sums.
  function count(root) {
    const seen = new Set();
    let v = 0, t = 0;
    root.traverse(o => {
      if (!o.isMesh || !o.geometry) return;
      const pos = o.geometry.getAttribute('position');
      if (pos && !seen.has(pos)) {
        seen.add(pos);
        v += pos.count;
      }
      const indexed = o.geometry.index ? o.geometry.index.count : (pos ? pos.count : 0);
      t += indexed / 3;
    });
    return { vertexCount: v, triangleCount: Math.round(t) };
  }
  return { original: count(origScene), reduced: count(reducedScene) };
}

function writeCSV(filepath, rows) {
  if (rows.length === 0) {
    fs.writeFileSync(filepath, '', 'utf-8');
    return;
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) lines.push(headers.map(h => formatCsv(row[h])).join(','));
  fs.writeFileSync(filepath, lines.join('\n') + '\n', 'utf-8');
}

function formatCsv(v) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    if (Number.isInteger(v)) return v.toString();
    return v.toString();
  }
  if (typeof v === 'string') {
    if (v.includes(',') || v.includes('"') || v.includes('\n')) {
      return '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }
  return String(v);
}

function computeStats(rows) {
  if (rows.length === 0) return null;
  const ssims = rows.map(r => r.ssim).slice().sort((a, b) => a - b);
  let maxDiff = 0;
  for (const r of rows) if (r.max_abs_diff > maxDiff) maxDiff = r.max_abs_diff;
  const sum = ssims.reduce((a, b) => a + b, 0);
  return {
    ssim_mean: round6(sum / ssims.length),
    ssim_p05: round6(ssims[Math.floor(ssims.length * 0.05)]),
    ssim_min: round6(ssims[0]),
    ssim_max: round6(ssims[ssims.length - 1]),
    max_abs_diff_max: maxDiff,
    n: ssims.length,
  };
}

function round6(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  return Math.round(v * 1e6) / 1e6;
}

module.exports = { runValidation, HELD_OUT_COUNT };
