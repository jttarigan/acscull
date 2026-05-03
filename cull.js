// ACSCull — visibility-aware triangle elimination for skinned characters.
// Reference implementation accompanying the MethodsX submission.
//
// Reads a bundle folder, runs the K×P visibility sampling pass, eliminates
// non-visible triangles, and writes the reduced GLB plus a sidecar JSON.
//
// Usage:
//   npx electron cull.js --bundle <folder> [--out <path>] [--save-merged <path>] [--acs <path>]
//
// Bundle layout:
//   <bundle>/
//     character.glb (or character.fbx)     — composed mesh, single skeleton
//     animations/*.fbx                      — optional, source clip FBXs
//     bundle.json                           — { name, acs, clipFilter, ... }
//
// Outputs (next to the input):
//   character_reduced.glb                   — culled mesh
//   character_reduced.glb.acsbake.json      — sidecar
//   character_reduced.glb.kept.bin          — per-triangle keep bitmap
//   character_merged.glb                    — pre-elimination merged GLB (if --save-merged)
//
// Exit: 0 = success, 1 = bake error, 2 = arg error.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = __dirname;

const DEFAULT_CLIP_FILTER = ['idle', 'run', 'walk', 'attack_punch'];
const BUNDLE_SCHEMA_VERSION = 1;

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { bundle: null, out: null, saveMerged: null, acs: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bundle') flags.bundle = args[++i];
    else if (a === '--out') flags.out = args[++i];
    else if (a === '--save-merged') flags.saveMerged = args[++i];
    else if (a === '--acs') flags.acs = args[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else if (!flags.bundle && !a.startsWith('--')) flags.bundle = a;
  }
  if (!flags.bundle) {
    console.error('cull.js: --bundle <folder> is required');
    printHelp();
    process.exit(2);
  }
  flags.bundle = path.resolve(flags.bundle);
  if (!fs.existsSync(flags.bundle) || !fs.statSync(flags.bundle).isDirectory()) {
    console.error('cull.js: bundle path is not a directory: ' + flags.bundle);
    process.exit(2);
  }
  if (!flags.out) flags.out = path.join(flags.bundle, 'character_reduced.glb');
  if (!flags.saveMerged) flags.saveMerged = path.join(flags.bundle, 'character_merged.glb');
  if (flags.acs && !path.isAbsolute(flags.acs)) flags.acs = path.resolve(flags.acs);
  if (!path.isAbsolute(flags.out)) flags.out = path.resolve(flags.out);
  if (!path.isAbsolute(flags.saveMerged)) flags.saveMerged = path.resolve(flags.saveMerged);
  return flags;
}

function printHelp() {
  console.log('Usage: npx electron cull.js --bundle <folder> [options]');
  console.log('');
  console.log('Options:');
  console.log('  --bundle <folder>     Bundle folder (required, can be passed positionally)');
  console.log('  --out <path>          Output reduced GLB (default: <bundle>/character_reduced.glb)');
  console.log('  --save-merged <path>  Pre-elimination merged GLB (default: <bundle>/character_merged.glb,');
  console.log('                        omit by passing an empty string)');
  console.log('  --acs <path>          ACS JSON path (overrides bundle.json acs and the project default)');
}

// Resolve effective ACS: --acs flag > bundle.json `acs` > data/acs_default.json.
// Returns the in-memory config object plus its source path for logging.
function resolveAcs(flags, bundleManifest) {
  if (flags.acs) return { path: flags.acs, fromInline: false };
  if (bundleManifest && bundleManifest.acs && typeof bundleManifest.acs === 'object') {
    return { path: null, fromInline: true, inline: bundleManifest.acs };
  }
  return { path: path.join(PROJECT_DIR, 'data', 'acs_default.json'), fromInline: false };
}

// Find the character mesh file in the bundle. Prefers GLB (faster load,
// trivially round-trippable through GLTFExporter); falls back to FBX so users
// can drop in DCC-exported assets without a viewer round-trip.
function findCharacterFile(bundleDir) {
  const candidates = ['character.glb', 'character.fbx'];
  for (const name of candidates) {
    const p = path.join(bundleDir, name);
    if (fs.existsSync(p)) return p;
  }
  throw new Error('No character.glb or character.fbx in bundle: ' + bundleDir);
}

function findAnimationFiles(bundleDir) {
  const animDir = path.join(bundleDir, 'animations');
  if (!fs.existsSync(animDir)) return [];
  return fs.readdirSync(animDir)
    .filter(f => f.toLowerCase().endsWith('.fbx'))
    .map(f => path.join(animDir, f))
    .sort();
}

function loadBundleManifest(bundleDir) {
  const manifestPath = path.join(bundleDir, 'bundle.json');
  if (!fs.existsSync(manifestPath)) {
    // Permissive: allow a bundle with no manifest. Defaults are applied.
    return { version: BUNDLE_SCHEMA_VERSION, name: path.basename(bundleDir) };
  }
  try {
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    const m = JSON.parse(raw);
    if (m.version && m.version !== BUNDLE_SCHEMA_VERSION) {
      console.warn('cull.js: bundle.json version=' + m.version
        + ', expected ' + BUNDLE_SCHEMA_VERSION + ' — proceeding anyway');
    }
    return m;
  } catch (err) {
    throw new Error('Failed to parse bundle.json: ' + err.message);
  }
}

const flags = parseArgs();
const bundleManifest = loadBundleManifest(flags.bundle);
const characterFile = findCharacterFile(flags.bundle);
const animationFiles = findAnimationFiles(flags.bundle);
const acsSource = resolveAcs(flags, bundleManifest);
// clipFilter is optional and additive: when present, only clips whose names
// substring-match an entry pass through; when absent or empty, every clip
// found in animations/ + intrinsic clips of character.glb is included. The
// "include all" default lets a user drop a Mixamo FBX into animations/ and
// re-cull without touching bundle.json.
const hasClipFilter = Array.isArray(bundleManifest.clipFilter) && bundleManifest.clipFilter.length > 0;
const clipFilter = hasClipFilter ? bundleManifest.clipFilter : null;

console.log('Bundle:      ' + flags.bundle);
console.log('Character:   ' + path.relative(flags.bundle, characterFile));
console.log('Animations:  ' + (animationFiles.length === 0
  ? '(none — clips read from character only)'
  : animationFiles.map(f => path.relative(flags.bundle, f)).join(', ')));
console.log('Clip filter: ' + (clipFilter ? clipFilter.join(', ') : '(none — using all clips)'));
console.log('Out:         ' + flags.out);

app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 256, height: 256, show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      offscreen: true,
    },
  });

  const htmlContent = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body><canvas id="c"></canvas>
<script>${buildRendererScript()}</script>
</body></html>`;

  const tmpHtml = path.join(flags.bundle, '_cull_tmp.html');
  fs.writeFileSync(tmpHtml, htmlContent, 'utf-8');
  win.loadFile(tmpHtml);

  win.webContents.on('console-message', (_e, _l, msg) => console.log('[cull]', msg));

  ipcMain.on('cull-done', (_e, info) => {
    console.log('\n=== Cull complete ===');
    console.log(JSON.stringify(info, null, 2));
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
    app.exit(0);
  });
  ipcMain.on('cull-error', (_e, err) => {
    console.error('\n=== Cull failed ===\n', err);
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
    app.exit(1);
  });
});

app.on('window-all-closed', () => app.quit());

function buildRendererScript() {
  return `
const THREE = require('three');
const { FBXLoader } = require('three/examples/jsm/loaders/FBXLoader.js');
const { GLTFLoader } = require('three/examples/jsm/loaders/GLTFLoader.js');
const { GLTFExporter } = require('three/examples/jsm/exporters/GLTFExporter.js');
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = ${JSON.stringify(PROJECT_DIR)};
const BUNDLE_DIR = ${JSON.stringify(flags.bundle)};
const CHARACTER_FILE = ${JSON.stringify(characterFile)};
const ANIMATION_FILES = ${JSON.stringify(animationFiles)};
const ACS_SOURCE = ${JSON.stringify(acsSource)};
const CLIP_FILTER = ${JSON.stringify(clipFilter)};
const BUNDLE_NAME = ${JSON.stringify(bundleManifest.name || path.basename(flags.bundle))};
const OUT_PATH = ${JSON.stringify(flags.out)};
const SAVE_MERGED = ${JSON.stringify(flags.saveMerged)};

const { mergeSkinned } = require(path.join(PROJECT_DIR, 'src', 'bake', 'mergeSkinned.js'));
const { buildBakingGeometry } = require(path.join(PROJECT_DIR, 'src', 'bake', 'bakingGeometry.js'));
const { loadAcsConfig } = require(path.join(PROJECT_DIR, 'src', 'bake', 'acsConfig.js'));
const { buildBakeShaderMaterial, attachBakeUniformHooks } = require(path.join(PROJECT_DIR, 'src', 'bake', 'bakeShaderMaterial.js'));
const { sampleCameras } = require(path.join(PROJECT_DIR, 'src', 'bake', 'cameraSampler.js'));
const { samplePoses } = require(path.join(PROJECT_DIR, 'src', 'bake', 'poseSampler.js'));
const { runVisibilityPass } = require(path.join(PROJECT_DIR, 'src', 'bake', 'visibilityPass.js'));
const { eliminateTriangles } = require(path.join(PROJECT_DIR, 'src', 'bake', 'triangleElimination.js'));
const { writeSidecar } = require(path.join(PROJECT_DIR, 'src', 'bake', 'sidecarWriter.js'));

(async () => {
  try {
    const t0 = Date.now();

    // ─── ACS config ───
    let acs;
    if (ACS_SOURCE.fromInline) {
      // Inline ACS in bundle.json — same schema as data/acs_default.json.
      // Run it through the validator by writing/reading via a temp path.
      const tmp = path.join(BUNDLE_DIR, '_acs_inline_tmp.json');
      fs.writeFileSync(tmp, JSON.stringify(ACS_SOURCE.inline, null, 2));
      try { acs = loadAcsConfig(tmp); } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
    } else {
      acs = loadAcsConfig(ACS_SOURCE.path);
    }
    console.log('ACS loaded: K=' + acs.k_cameras + ' P=' + acs.p_poses
      + ' res=' + acs.render_resolution.join('x') + ' ss=' + acs.supersample);

    const canvas = document.getElementById('c');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(256, 256);

    const gl = renderer.getContext();
    const deviceFingerprint = [
      'GL_VENDOR=' + gl.getParameter(gl.VENDOR),
      'GL_RENDERER=' + gl.getParameter(gl.RENDERER),
      'GL_VERSION=' + gl.getParameter(gl.VERSION),
    ].join(';');

    const scene = new THREE.Scene();

    // ─── Character + clips ───
    console.log('Loading character: ' + path.basename(CHARACTER_FILE));
    const isGlb = /\\.glb$/i.test(CHARACTER_FILE);
    let baseObj, intrinsicAnims;
    if (isGlb) {
      const gltf = await loadGLB(CHARACTER_FILE);
      baseObj = gltf.scene;
      intrinsicAnims = gltf.animations || [];
    } else {
      baseObj = await loadFBX(CHARACTER_FILE, path.dirname(CHARACTER_FILE) + '/');
      intrinsicAnims = baseObj.animations || [];
    }

    const skins = [];
    baseObj.traverse(c => { if (c.isSkinnedMesh) skins.push(c); });
    if (skins.length === 0) throw new Error('No SkinnedMesh in ' + CHARACTER_FILE
      + ' — ACSCull is for skinned characters only.');
    const attachments = skins.slice(1);

    // Concat extra clips from animations/*.fbx, then filter by name substring.
    const externalAnims = [];
    for (const animFile of ANIMATION_FILES) {
      console.log('Loading animations: ' + path.basename(animFile));
      const obj = await loadFBX(animFile, path.dirname(animFile) + '/');
      const clips = obj.animations || [];
      for (const c of clips) externalAnims.push(c);
    }
    // Strip "bad" tracks that some FBX exports embed:
    //   - *.scale tracks: FBX cm→m unit metadata leaks as 100× scale tracks
    //     on every bone (e.g. astronaut Character_Animations.fbx). Three.js
    //     applies them every mixer.update → bone matrices blow up ~100×, the
    //     skinned mesh renders far off-camera, and the visibility pass only
    //     catches the few triangles that happen to fall within the camera's
    //     range. Without this filter, astronaut/animal-builder bundles get
    //     ~98%+ "reduction" because most triangles are never seen.
    //   - Root.position tracks: root-motion drift that pulls the character
    //     out of the ACS target window across the clip. Removing it keeps
    //     the character near target_offset for the whole sample.
    // Mirrors viewer renderer.js's stripBadTracks. Aminset_Basic / Piloto
    // clips don't have these artifacts; the filter is a no-op there.
    function stripBadTracks(clips) {
      return clips.map(clip => {
        const filtered = clip.tracks.filter(t => {
          if (/\\.scale$/.test(t.name)) return false;
          if (/^Root\\.position$/.test(t.name)) return false;
          return true;
        });
        return new THREE.AnimationClip(clip.name, clip.duration, filtered);
      });
    }
    const allClips = stripBadTracks([...intrinsicAnims, ...externalAnims]);
    // clipFilter is optional. null/empty → use all clips found. Otherwise
    // substring-match (case-insensitive) so legacy filters like
    // ["idle","run"] still work alongside exact-name picks.
    const exportAnims = (CLIP_FILTER && CLIP_FILTER.length > 0)
      ? allClips.filter(c => {
          const n = c.name.toLowerCase();
          return CLIP_FILTER.some(f => n.includes(f.toLowerCase()));
        })
      : allClips;
    if (exportAnims.length === 0) {
      const filterDesc = (CLIP_FILTER && CLIP_FILTER.length > 0)
        ? 'filter [' + CLIP_FILTER.join(', ') + ']'
        : '(no filter)';
      throw new Error('No clips matched ' + filterDesc
        + '. Available: ' + allClips.map(c => c.name).join(', '));
    }
    baseObj.animations = exportAnims;
    console.log('Clips: ' + allClips.length + ' total → ' + exportAnims.length
      + (CLIP_FILTER ? ' kept by filter' : ' (no filter, using all)'));

    scene.add(baseObj);

    // ─── Merge ───
    const preMergeMeshes = [];
    baseObj.traverse(c => { if (c.isMesh) preMergeMeshes.push(c); });

    console.log('Merging...');
    const merged = mergeSkinned(baseObj, attachments);
    const mergeStats = merged.userData.acscull.mergeStats;
    console.log('Merged: ' + mergeStats.vertexCount + ' verts, ' + mergeStats.triangleCount + ' tris, '
      + mergeStats.submeshCount + ' submeshes');

    preMergeMeshes.forEach(m => { if (m.parent) m.parent.remove(m); });
    baseObj.add(merged);

    if (SAVE_MERGED) {
      console.log('Saving pre-reduction merged GLB: ' + SAVE_MERGED);
      await exportGlbStrippingMaps(scene, exportAnims, SAVE_MERGED);
    }

    // ─── Bake mesh + R32UI render target ───
    const W = acs.render_resolution[0] * acs.supersample;
    const H = acs.render_resolution[1] * acs.supersample;
    console.log('Bake target: ' + W + 'x' + H + ' R32UI');

    const bakingGeom = buildBakingGeometry(merged.geometry);
    const bakeMat = buildBakeShaderMaterial();
    const bakeMesh = new THREE.SkinnedMesh(bakingGeom, bakeMat);
    bakeMesh.bind(merged.skeleton, merged.bindMatrix);
    attachBakeUniformHooks(bakeMesh, bakeMat);
    // Disable frustum culling: SkinnedMesh's default bbox check uses
    // attribute-space positions, not bone-deformed positions, so when the
    // input GLB has nested transforms (e.g., autoFitAndCenter scale + ±90°
    // FBX axis flip from in-app exportBundle output), the renderer thinks
    // the bake mesh is far from the camera frustum and skips most groups.
    // The cull NEEDS every group to render — visibility = whatever camera
    // saw, not whatever the engine decided to draw.
    bakeMesh.frustumCulled = false;

    const bakeScene = new THREE.Scene();
    bakeScene.add(bakeMesh);

    const depthTex = new THREE.DepthTexture(W, H, THREE.UnsignedIntType);
    depthTex.format = THREE.DepthFormat;
    const rt = new THREE.WebGLRenderTarget(W, H, {
      format: THREE.RedIntegerFormat,
      type: THREE.UnsignedIntType,
      internalFormat: 'R32UI',
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
      generateMipmaps: false,
      depthBuffer: true,
      depthTexture: depthTex,
    });

    // ─── Samplers ───
    const cameras = sampleCameras(acs, acs.k_cameras);
    const poses = samplePoses(exportAnims, acs);
    console.log('Samples: ' + cameras.length + ' cameras × ' + poses.length + ' poses = '
      + (cameras.length * poses.length));

    // ─── Pose management ───
    const mixer = new THREE.AnimationMixer(baseObj);
    const actionByClip = new Map();
    for (const pose of poses) {
      if (pose.clip && !actionByClip.has(pose.clip)) {
        const action = mixer.clipAction(pose.clip);
        action.play();
        actionByClip.set(pose.clip, action);
      }
    }
    function applyPose(pose) {
      for (const [clip, action] of actionByClip) {
        action.weight = (pose.clip && clip === pose.clip) ? 1 : 0;
      }
      mixer.setTime(pose.time || 0);
      baseObj.updateMatrixWorld(true);
    }

    // ─── Visibility pass ───
    console.log('Running visibility pass...');
    const visResult = runVisibilityPass({
      renderer,
      scene: bakeScene,
      bakeMesh,
      cameras,
      poses,
      applyPose,
      triangleCount: mergeStats.triangleCount,
      renderTarget: rt,
      onProgress(info) {
        console.log('  ' + info.sampleIdx + '/' + info.total
          + ' (' + info.trianglesSeen + '/' + mergeStats.triangleCount + ' tris, '
          + info.elapsedSeconds.toFixed(1) + 's)');
      },
    });
    console.log('Visibility pass: ' + visResult.trianglesSeen + '/' + mergeStats.triangleCount
      + ' triangles visible (' + visResult.elapsedSeconds.toFixed(1) + 's)');

    rt.dispose();
    bakeMat.dispose();

    // ─── Elimination ───
    console.log('Eliminating...');
    const origMaterials = Array.isArray(merged.material) ? merged.material : [merged.material];
    const elim = eliminateTriangles(merged.geometry, visResult.bitset, origMaterials);
    console.log('Kept: ' + elim.stats.keptTriangleCount + '/' + elim.stats.originalTriangleCount + ' tris ('
      + (elim.stats.reductionRatio * 100).toFixed(1) + '% removed), '
      + elim.stats.keptVertexCount + '/' + elim.stats.originalVertexCount + ' verts, '
      + elim.stats.keptMaterialCount + '/' + elim.stats.originalMaterialCount + ' materials');

    merged.geometry.dispose();
    merged.geometry = elim.geometry;
    merged.material = elim.materials.length === 1 ? elim.materials[0] : elim.materials;

    // ─── Export reduced GLB ───
    console.log('Exporting reduced GLB...');
    const outDir = path.dirname(OUT_PATH);
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const buf = await exportGlbStrippingMaps(scene, exportAnims, OUT_PATH);
    const sizeMB = (buf.length / 1024 / 1024).toFixed(2);

    // ─── Per-triangle keep bitmap ───
    const keptPath = OUT_PATH + '.kept.bin';
    fs.writeFileSync(keptPath, Buffer.from(elim.kept.buffer, elim.kept.byteOffset, elim.kept.byteLength));

    // ─── Sidecar ───
    const bakeWallTimeSeconds = (Date.now() - t0) / 1000;
    const sidecarPath = OUT_PATH + '.acsbake.json';
    writeSidecar(sidecarPath, {
      sourcePreset: 'bundle:' + BUNDLE_NAME,
      sourceParts: [path.basename(CHARACTER_FILE), ...ANIMATION_FILES.map(p => 'animations/' + path.basename(p))],
      acs,
      pPosesSampled: poses.length,
      originalTriangleCount: elim.stats.originalTriangleCount,
      keptTriangleCount: elim.stats.keptTriangleCount,
      reductionRatio: elim.stats.reductionRatio,
      originalVertexCount: elim.stats.originalVertexCount,
      keptVertexCount: elim.stats.keptVertexCount,
      vertexReductionRatio: elim.stats.vertexReductionRatio,
      bakeWallTimeSeconds,
      deviceFingerprint,
    });

    ipcRenderer.send('cull-done', {
      bundleName: BUNDLE_NAME,
      outPath: OUT_PATH,
      sizeBytes: buf.length,
      sizeMB: sizeMB + ' MB',
      elapsedSeconds: bakeWallTimeSeconds.toFixed(1),
      sidecarPath,
      keptBitmapPath: keptPath,
      mergedPath: SAVE_MERGED,
      mergeStats,
      reductionStats: elim.stats,
      trianglesSeen: visResult.trianglesSeen,
    });
  } catch (err) {
    ipcRenderer.send('cull-error', String(err.stack || err));
  }
})();

function loadFBX(fp, resourcePath) {
  return new Promise((res, rej) => {
    const L = new FBXLoader();
    if (resourcePath) L.setResourcePath(resourcePath);
    L.load(fp, res, undefined, rej);
  });
}

function loadGLB(fp) {
  return new Promise((res, rej) => {
    const buf = fs.readFileSync(fp);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    new GLTFLoader().parse(ab, '', res, rej);
  });
}

// CanvasTextures and stale FBX maps occasionally lack decode-ready image data
// and crash GLTFExporter. Vertex colors carry the visible coloring, so strip
// mat.map across the scene before each export and restore after.
async function exportGlbStrippingMaps(scene, animations, outPath) {
  const savedMaps = [];
  scene.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach(m => { if (m && m.map) { savedMaps.push({ m, map: m.map }); m.map = null; } });
  });
  let buf;
  try {
    const exporter = new GLTFExporter();
    const glb = await exporter.parseAsync(scene, {
      binary: true, animations, includeCustomExtensions: false,
    });
    buf = Buffer.from(glb);
    fs.writeFileSync(outPath, buf);
  } finally {
    savedMaps.forEach(({ m, map }) => { m.map = map; });
  }
  return buf;
}
`;
}
