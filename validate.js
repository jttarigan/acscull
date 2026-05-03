// ACSCull validation harness — held-out camera SSIM check.
//
// Renders the merged (pre-elimination) GLB and the reduced GLB from cameras
// drawn from a Halton sequence with bases distinct from the bake's, computes
// SSIM (Wang et al. 2004, 11×11 Gaussian, K1=0.01, K2=0.03, L=255) plus
// max-channel abs-diff per camera, and writes per-camera CSVs and a summary.
//
// Usage:
//   npx electron validate.js --bundle <folder> [--out <folder>]
//
// Bundle inputs (resolved automatically):
//   <bundle>/character_merged.glb     — original, written by `cull.js --save-merged`
//   <bundle>/character_reduced.glb    — reduced, written by `cull.js`
//   <bundle>/bundle.json (.acs)       — used if present, else data/acs_default.json
//
// Or pass paths explicitly: --original <path> --reduced <path> --acs <path>
//
// Exit: 0 = success, 1 = error, 2 = arg error.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = __dirname;

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { bundle: null, original: null, reduced: null, acs: null, out: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--bundle') flags.bundle = args[++i];
    else if (a === '--original') flags.original = args[++i];
    else if (a === '--reduced') flags.reduced = args[++i];
    else if (a === '--acs') flags.acs = args[++i];
    else if (a === '--out') flags.out = args[++i];
    else if (!flags.bundle && !a.startsWith('--')) flags.bundle = a;
  }

  if (flags.bundle) {
    flags.bundle = path.resolve(flags.bundle);
    if (!flags.original) flags.original = path.join(flags.bundle, 'character_merged.glb');
    if (!flags.reduced) flags.reduced = path.join(flags.bundle, 'character_reduced.glb');
    if (!flags.out) flags.out = path.join(flags.bundle, 'validation');
    if (!flags.acs) {
      const manifestPath = path.join(flags.bundle, 'bundle.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
          if (m.acs && typeof m.acs === 'object') {
            const tmp = path.join(flags.bundle, '_acs_inline_validate_tmp.json');
            fs.writeFileSync(tmp, JSON.stringify(m.acs, null, 2));
            flags.acs = tmp;
            flags._acsTmp = tmp;
          }
        } catch (_) {}
      }
    }
  }
  if (!flags.acs) flags.acs = path.join(PROJECT_DIR, 'data', 'acs_default.json');
  if (!flags.original || !flags.reduced || !flags.out) {
    console.error('validate.js: provide --bundle <folder>, or pass --original, --reduced, --out explicitly');
    process.exit(2);
  }
  for (const k of ['original', 'reduced', 'acs', 'out']) {
    if (!path.isAbsolute(flags[k])) flags[k] = path.resolve(flags[k]);
  }
  if (!fs.existsSync(flags.original)) {
    console.error('validate.js: --original not found: ' + flags.original
      + '\n  (did you run `cull.js --save-merged` to write character_merged.glb?)');
    process.exit(2);
  }
  if (!fs.existsSync(flags.reduced)) {
    console.error('validate.js: --reduced not found: ' + flags.reduced);
    process.exit(2);
  }
  return flags;
}

const flags = parseArgs();

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

  const tmpHtml = path.join(flags.out, '_validate_tmp.html');
  fs.mkdirSync(flags.out, { recursive: true });
  fs.writeFileSync(tmpHtml, htmlContent, 'utf-8');
  win.loadFile(tmpHtml);

  win.webContents.on('console-message', (_e, _l, msg) => console.log('[validate]', msg));

  const cleanup = () => {
    try { fs.unlinkSync(tmpHtml); } catch (_) {}
    if (flags._acsTmp) { try { fs.unlinkSync(flags._acsTmp); } catch (_) {} }
  };

  ipcMain.on('validate-done', (_e, info) => {
    console.log('\n=== Validation complete ===');
    console.log(JSON.stringify(info.summary, null, 2));
    cleanup();
    app.exit(0);
  });
  ipcMain.on('validate-error', (_e, err) => {
    console.error('\n=== Validation failed ===\n', err);
    cleanup();
    app.exit(1);
  });
});

app.on('window-all-closed', () => app.quit());

function buildRendererScript() {
  return `
const THREE = require('three');
const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

const PROJECT_DIR = ${JSON.stringify(PROJECT_DIR)};
const ORIGINAL_PATH = ${JSON.stringify(flags.original)};
const REDUCED_PATH = ${JSON.stringify(flags.reduced)};
const ACS_PATH = ${JSON.stringify(flags.acs)};
const OUT_DIR = ${JSON.stringify(flags.out)};

const { loadAcsConfig } = require(path.join(PROJECT_DIR, 'src', 'bake', 'acsConfig.js'));
const { runValidation } = require(path.join(PROJECT_DIR, 'src', 'validate', 'validationRunner.js'));

(async () => {
  try {
    const t0 = Date.now();
    console.log('Original: ' + ORIGINAL_PATH);
    console.log('Reduced:  ' + REDUCED_PATH);
    console.log('ACS:      ' + ACS_PATH);
    console.log('Out dir:  ' + OUT_DIR);

    const acs = loadAcsConfig(ACS_PATH);

    const canvas = document.getElementById('c');
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    renderer.setSize(256, 256);
    renderer.setClearColor(0x222233, 1);

    const summary = await runValidation({
      renderer,
      originalPath: ORIGINAL_PATH,
      reducedPath: REDUCED_PATH,
      acs,
      outDir: OUT_DIR,
      onProgress(p) {
        console.log('  ' + p.label + ' ' + p.done + '/' + p.total
          + ' ssim=' + p.ssim.toFixed(4)
          + ' max_abs=' + p.maxAbsDiff
          + ' (' + p.elapsedSeconds.toFixed(1) + 's)');
      },
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log('Total: ' + elapsed + 's');
    ipcRenderer.send('validate-done', { summary, elapsedSeconds: elapsed });
  } catch (err) {
    ipcRenderer.send('validate-error', String(err.stack || err));
  }
})();
`;
}
