# ACSCull

Visibility-aware triangle elimination for skinned characters in top-down games.

ACSCull is an **offline pre-pass** that removes triangles which are never visible from any camera within a game's *Admissible Camera Set* (ACS) — the 5-tuple `(pitch range, yaw range, distance range, FOV, aspect)` defining the cinematic envelope the game ever shows the asset under. For top-down games, that's typically a tight pitch band (e.g. 55°–70°) and a fixed FOV; under those constraints, **30–55% of the triangles on a typical hand-authored character are never rasterized**. This tool removes them.

The output is a standard glTF Binary (GLB) — drop-in compatible with any glTF-consuming runtime (cgltf, three.js, Babylon.js, custom NDK/GL ES loaders).

This is the reference implementation accompanying the methods paper. See [`SPEC.md`](SPEC.md) for the algorithm, and [`CITATION.cff`](CITATION.cff) for citation.

## Pipeline

```
bundle/                              cull.js                      bundle/
├── character.glb           ──►   merge → bake → eliminate    ──►   character_reduced.glb
├── animations/*.fbx                                                character_reduced.glb.acsbake.json
└── bundle.json                                                     character_reduced.glb.kept.bin
                                                                    character_merged.glb (optional)
```

1. **Merge** every `SkinnedMesh` in the input into a single bind-space-reconciled skinned mesh.
2. **Bake** triangle IDs as a flat-interpolated vertex attribute, render through the runtime's skinning shader to an `R32UI` render target.
3. **Sample** K cameras × P poses across the ACS via low-discrepancy (Halton) sequences, accumulating a triangle visibility bitset.
4. **Eliminate** triangles outside the visibility set; rebuild geometry, vertex remap, group ranges, and material list.
5. **Export** as GLB; write per-triangle keep bitmap and reproducibility sidecar.

## Install

```bash
git clone https://github.com/jttarigan/acscull
cd acscull
npm install
```

Requires Node ≥ 18 and Electron 41+ (installed via npm). Tested on Windows 11; macOS / Linux should work but are not in CI yet.

## Usage

A **bundle** is a folder containing a composed character mesh plus optional animation FBXs. Layout:

```
my-character/
├── character.glb       # composed, single-tree, single-skin (or character.fbx)
├── animations/         # optional — extra clip FBXs concatenated at load time
│   └── *.fbx
└── bundle.json         # manifest (see schema below)
```

Run the cull:

```bash
npx electron cull.js --bundle path/to/my-character
```

This writes:

- `character_reduced.glb` — culled mesh (ship this).
- `character_reduced.glb.acsbake.json` — sidecar with original/kept triangle counts, ACS used, device fingerprint, wall time.
- `character_reduced.glb.kept.bin` — per-triangle keep bitmap (`Uint8Array`, 1 byte per triangle, indexed against the merged geometry's triangle order).
- `character_merged.glb` — pre-elimination merged GLB (used by the validation harness).

Validate against the original:

```bash
npx electron validate.js --bundle path/to/my-character
```

Renders both meshes from 128 held-out cameras (Halton bases distinct from the cull's), computes SSIM (Wang et al. 2004, 11×11 Gaussian, K1=0.01, K2=0.03, L=255) and per-channel max-abs-diff, writes CSVs and a summary JSON to `<bundle>/validation/`.

## Bundle manifest (`bundle.json`)

```json
{
  "version": 1,
  "name": "fox",
  "description": "Khronos Fox sample bundle",
  "acs": {
    "version": 1,
    "pitch_min_deg": 55, "pitch_max_deg": 70,
    "yaw_min_deg": 0,    "yaw_max_deg": 360,
    "distance_min": 8,   "distance_max": 12,
    "horizontal_fov_deg": 60,
    "aspect_ratio": 1.7777778,
    "target_offset": [0, 1, 0],
    "k_cameras": 64, "p_poses": 20,
    "supersample": 2, "render_resolution": [512, 512],
    "pose_animations": ["idle", "walk", "run"],
    "pose_sample_stride": 4
  },
  "clipFilter": ["idle", "run", "walk", "attack_punch"]
}
```

All fields except `name` are optional. Defaults:

- `acs` → [`data/acs_default.json`](data/acs_default.json) (a 55°–70° pitch, 60° FOV, 16:9 ACS suitable for typical mobile top-down).
- `clipFilter` → `["idle", "run", "walk", "attack_punch"]` (case-insensitive substring match against clip names).

The bundle can also carry an `authoringPreset` field — opaque to ACSCull, used by upstream authoring tools to round-trip edits.

## Inputs the cull accepts

The cull is **format-permissive on input** and **strict on output**:

- Input: `character.glb` *or* `character.fbx` (auto-detected). Use whichever your DCC tool exports cleanly.
- Animations: any number of `.fbx` files in `<bundle>/animations/`. Clips with names containing any string in `clipFilter` (case-insensitive) are kept.
- Output: always GLB. Designed to be consumed by mobile/embedded runtimes via cgltf or equivalent.

## Why GLB?

Mobile NDK / GL ES targets benefit hugely from glTF Binary's runtime-shaped data:

- **cgltf** is a single-header C library (~5K LOC) that parses GLB in milliseconds — orders of magnitude faster than any FBX parser.
- glTF buffer views map 1:1 to GL vertex attributes; you point `glVertexAttribPointer` at the buffer offset and bind.
- Skinning data is runtime-ready: flat `inverseBindMatrices` arrays, animation samplers (linear/step/cubic) trivially CPU-evaluated.

FBX is an authoring/interchange format; GLB is a runtime format. The pipeline accepts FBX in (because vendor packs ship it) and emits GLB out (because runtimes want it).

## Tests

```bash
npm test                      # pure-Node tests (bakingGeometry, ssim)
npm run test:bakingGeometry
npm run test:ssim
```

Pure-Node tests run in CI (see [`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Integration tests requiring headless Electron + GPU run locally.

## Sample bundles

A `examples/` folder ships a fetch script that pulls Khronos's CC-BY-licensed [Fox sample model](https://github.com/KhronosGroup/glTF-Sample-Assets):

```bash
bash examples/fetch_samples.sh
npx electron cull.js --bundle examples/fox
```

Expected reduction on the Fox sample with default ACS: ~38% triangles removed (verify against your local run).

## Repository layout

```
acscull/
├── cull.js                  # bundle-aware bake entry (run with: npx electron cull.js)
├── validate.js              # held-out SSIM harness
├── src/
│   ├── bake/                # merge, bakingGeometry, visibilityPass, elimination, …
│   └── validate/            # heldOutCameras, ssim, validationRunner
├── tests/
│   ├── bakingGeometry.test.js
│   └── ssim.test.js
├── data/acs_default.json
├── examples/                # sample bundles (fetched at runtime, not in git)
├── SPEC.md
├── CITATION.cff
└── LICENSE                  # Apache-2.0
```

## License

[Apache-2.0](LICENSE). Includes an explicit patent grant. Sample bundle assets fetched by `examples/fetch_samples.sh` are governed by their own upstream licenses (CC-BY for Khronos sample assets — preserve attribution if redistributing).

## Citation

If you use ACSCull in academic work, please cite both the software (via [`CITATION.cff`](CITATION.cff)) and the methods paper.
