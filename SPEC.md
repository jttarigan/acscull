# ACSCull — Implementation Specification

**Version:** 0.2 (retargeted to Electron + Three.js + WebGL2)
**Supersedes:** v0.1 (C++/NDK target, superseded after stack confirmation)
**Target project:** existing character viewer (Electron + Three.js) with composition, FBX loading, and GLB export
**Status:** design locked; implementation not started

## 0. About this document

This spec defines the implementation of **ACSCull** (Admissible-Camera-Set Culling), a visibility-aware triangle-elimination pre-pass for pre-composed skinned character meshes in top-down mobile games. The method is the subject of a planned MethodsX submission; the implementation described here is both the shipping code path for the game pipeline and the reference implementation accompanying the paper.

### 0.1 What changed from v0.1

v0.1 assumed a C++/NDK viewer and mandated OpenGL ES 3.2 for `gl_PrimitiveID`. The viewer is actually Electron + Three.js running on WebGL2, which has no `gl_PrimitiveID`. v0.2 retargets the entire implementation to the existing JS stack:

- Merge pass uses Three.js's `BufferGeometryUtils.mergeGeometries` as a starting point.
- Bake mode runs as a headless Electron entry point, paralleling the existing `export_glb.js` pattern.
- Triangle ID is carried as a flat-interpolated per-vertex attribute (requires vertex duplication at bake setup); `gl_PrimitiveID` is not used.
- Output format is GLB via the existing `GLTFExporter` — no custom `.acsmesh` format.
- Reduced GLB replaces the original in place; a `.original.glb` backup is kept.

### 0.2 Terminology

- **ACS (Admissible Camera Set):** the 5-tuple (pitch range, yaw range, distance range, horizontal FOV, aspect) that defines the set of camera poses under which the asset must look identical to its unreduced source. Game-wide, not per-asset.
- **Part:** one of the FBX files the viewer loads and composes (body, shirt, pants, hat, weapon, etc.).
- **Merged mesh:** the single `SkinnedMesh` with one `BufferGeometry` produced by merging N parts. Input to ACSCull.
- **Reduced mesh:** the output of ACSCull. Invisible triangles removed, vertices re-packed.
- **Visibility set:** the set of triangle indices (in the merged mesh) rasterized into at least one pixel across all sampled (camera, pose) pairs.

### 0.3 Scope (v1)

- Pre-composed skinned characters (single skeleton, opaque materials).
- Top-down camera range (typical pitch 45°–75°, full yaw).
- Offline bake via headless Electron; no runtime decimation; no interactive UI.
- GLB output via Three.js's `GLTFExporter`; same consumption path as the existing `export_glb.js` / `export_piloto_glb.js`.
- Single ACS per game; one bake per composed character.

Out of scope for v1 (deferred to v2, see §7):

- Transparent / alpha-tested materials.
- Distinct shadow-caster geometry.
- Multi-context / wardrobe combinatorial baking (the pipeline pre-composes — no wardrobe at runtime).
- Interactive `B`-key bake mode in the viewer UI.
- Analytical fast-pass (sampling-only for v1).
- Atlas-batched readbacks.

## 1. Merge pass

### 1.1 Problem statement

The viewer's current composition (`renderer.js::attachMesh`) adds each attachment as a sibling `SkinnedMesh` sharing the base character's bone array by name. This renders correctly but leaves N sibling meshes in the scene, each with its own geometry. ACSCull needs a single `SkinnedMesh` with a single merged `BufferGeometry` as input. The merge pass produces this.

The viewer already resolves the asymmetric `bindMatrix` / `boneInverses` issue between attachments and the base skeleton at attachment time — the merge pass must preserve that correctness after concatenating geometries.

### 1.2 Input

A base `SkinnedMesh` plus N child `SkinnedMesh` attachments, all sharing the base skeleton's bone array by name. This is the existing in-memory scene after composition.

### 1.3 Algorithm

1. **Skeleton verification.** Walk each attachment's `skeleton.bones` array. For every bone, assert the name exists in the base skeleton. Abort with a clear error on mismatch, naming the offending attachment and bone. Parent-topology correctness is not re-verified here — it is enforced upstream by `renderer.js::attachMesh`'s name-based bone rebinding, which ensures each attachment bone is the corresponding base skeleton bone by the time merge runs; topology-mismatched attachments would fail to bind before reaching this function.

2. **Bind-space reconciliation.** Each attachment carries its own `boneInverses` and `bindMatrix` inherited from its source FBX. For the merged geometry, all vertices must be expressible in the *base skeleton's* bind space. For each attachment, compute the per-bone transform that takes a vertex from the attachment's bind space to the base bind space:

   ```
   delta_bone[i] = base.boneInverses[i] * attachment.bindMatrix * inv(attachment.boneInverses[i])
   ```

   Apply `delta_bone[i]` to the attachment's vertex positions on the CPU before concatenation (use the dominant influence's bone for the per-vertex delta, or compute the weighted sum of deltas using skinWeights). Transform normals and tangents by the inverse-transpose of the 3x3 part. After this step, the attachment's geometry is in base bind space and can share the base skeleton's bind matrices directly.

   **This is the trickiest step.** If wrong, bake skinning will produce vertex positions that differ from the runtime's, and visibility sampling will be unsound. Test explicitly (§1.6).

3. **Geometry concatenation.** Use `THREE.BufferGeometryUtils.mergeGeometries([base.geometry, ...reconciled_attachment_geometries], true)` with `useGroups: true`. This produces a single `BufferGeometry` with concatenated position / normal / tangent / uv / skinIndex / skinWeight attributes, a concatenated index buffer, and groups preserved per original geometry so materials can be assigned per-group.

4. **Material list assembly.** Collect materials from base + attachments in group order. Deduplicate by reference equality. Emit a `materials: Material[]` array aligned to the geometry's groups. The merged `SkinnedMesh` receives this as its `material` property.

5. **Skeleton attachment.** Create a single `THREE.Skeleton` from the base skeleton's bones and `boneInverses`. Construct the merged `SkinnedMesh`:

   ```js
   const merged = new THREE.SkinnedMesh(mergedGeometry, materials);
   merged.bind(new THREE.Skeleton(base.skeleton.bones, base.skeleton.boneInverses), base.bindMatrix);
   ```

6. **Animation copy-through.** The base model's animations (`AnimationClip[]`) transfer unchanged; attachments do not carry independent animations in this project. If the base has no animations but an attachment does, log a warning and pick the first animation-bearing attachment.

7. **Degenerate triangle filtering.** Walk the merged index buffer; discard any triangle with two or more identical indices. Report count.

### 1.4 Output

A single `THREE.SkinnedMesh` with:

- One `BufferGeometry` with merged attributes, indices, and groups.
- One `Material[]` aligned to groups.
- Base skeleton attached via `.bind()`.
- `userData.acscull.sourceParts = [...]` listing the names/paths of parts that went into the merge (for the sidecar).
- `userData.acscull.mergeStats = { vertexCount, triangleCount, submeshCount, materialCount }`.

### 1.5 File

`src/bake/mergeSkinned.js` exporting:

```js
export function mergeSkinned(baseModel, attachments) { /* returns SkinnedMesh */ }
```

### 1.6 Test

`tests/mergeSkinned.test.js`:

- Load `preset01.json` (the same preset `export_glb.js` uses) in a headless Electron window.
- Produce the composed scene using the existing `attachMesh` flow.
- Run `mergeSkinned()`.
- Assert: merged triangle count equals sum of per-part triangle counts (minus degenerates).
- Assert: merged vertex count equals sum of per-part vertex counts.
- Assert: rendering the merged mesh at the bind pose and rendering the pre-merge composed scene at the bind pose produce pixel outputs with SSIM >= 0.999. (This validates bind-space reconciliation — if step 2 is wrong, positions will be shifted and this test will fail.)
- Assert: rendering at animation time t=0.5s on the same camera also produces SSIM >= 0.999. (This validates skinning correctness.)

## 2. Bake mode (headless)

The bake is a new headless Electron entry point `bake.js`, paralleling `export_glb.js`. It is run from the command line:

```
npx electron bake.js --preset preset01.json --acs data/acs_default.json --out assets/player.glb
```

There is no interactive UI. The bake window may be offscreen (`show: false`) — same pattern as `export_glb.js`.

### 2.1 Top-level flow

Inside the headless window's renderer script:

1. Create a Three.js scene, camera, and `WebGLRenderer({ preserveDrawingBuffer: false, antialias: false, powerPreference: 'high-performance' })`.
2. Load the preset; compose the character using the existing composition code path.
3. Call `mergeSkinned()` from §1 to produce the merged `SkinnedMesh`.
4. Load the ACS JSON; validate (§2.2).
5. Build a "baking geometry" from the merged geometry (§2.3): triangle-duplicated vertices with a per-vertex `aTriId` attribute.
6. Create a custom `ShaderMaterial` (§2.4) that runs Three.js's skinning chunks in the vertex shader and writes triangle IDs in the fragment shader.
7. Create an R32UI render target (§2.5).
8. Run the sampling loop (§2.6): K cameras x P poses, render to the R32UI target, read back, union triangle IDs into a visibility bitset.
9. Eliminate non-visible triangles from the merged geometry (§2.7).
10. Before writing the reduced GLB, rename the existing output path to `.original.glb` as a backup (§3.1).
11. Export the reduced merged `SkinnedMesh` via `GLTFExporter` to the target path (§3.2).
12. Write the `.acsbake.json` sidecar (§3.3).
13. Print the stats, quit the app with exit code 0 (or non-zero on failure).

### 2.2 ACS JSON schema

File: `data/acs_default.json`.

```json
{
  "version": 1,
  "pitch_min_deg": 55.0,
  "pitch_max_deg": 70.0,
  "yaw_min_deg": 0.0,
  "yaw_max_deg": 360.0,
  "distance_min": 8.0,
  "distance_max": 12.0,
  "horizontal_fov_deg": 60.0,
  "aspect_ratio": 1.7777778,
  "target_offset": [0.0, 1.0, 0.0],
  "k_cameras": 64,
  "p_poses": 20,
  "supersample": 2,
  "render_resolution": [512, 512],
  "pose_animations": ["idle", "walk", "run", "attack_1", "death"],
  "pose_sample_stride": 4
}
```

Fields: `pitch` is measured from horizontal (90° = straight down). The JSON loader is `src/bake/acsConfig.js`; it validates presence and value ranges.

### 2.3 Baking geometry construction

WebGL2 has no `gl_PrimitiveID` in fragment shaders, so the triangle ID is carried as a flat-interpolated per-vertex attribute. At bake setup (not runtime, not game output):

1. Walk the merged indexed geometry. For each triangle `t` with indices `(i0, i1, i2)`:
   - Emit three new vertices carrying the attribute values of `i0`, `i1`, `i2` respectively.
   - Additionally stamp each of the three new vertices with `aTriId = t`.
   - Emit three new consecutive indices `(3t, 3t+1, 3t+2)`.

2. The resulting geometry has `3 * triangle_count` vertices and the same triangle count. Vertex buffer is ~3x larger than the merged source; fine at bake time.

3. Preserve all skinning attributes (`skinIndex`, `skinWeight`) through duplication so the skinning path produces correct positions.

4. The `aTriId` attribute is declared as `{ itemSize: 1, array: Uint32Array, normalized: false }`, bound to a vertex shader `in uint aTriId`.

**This geometry is bake-only.** It is not exported. Only the source merged geometry (minus eliminated triangles) is re-indexed for output.

### 2.4 Shader material

A custom `THREE.ShaderMaterial` that:

- Replicates Three.js's skinning vertex shader pipeline using `THREE.ShaderChunk` includes (`common`, `skinning_pars_vertex`, `skinbase_vertex`, `skinning_vertex`).
- Passes `aTriId` through as `flat out uint vTriId`.
- Fragment shader writes `uvec4(vTriId + 1u, 0u, 0u, 0u)` to the R32UI target. `+ 1u` offsets so that 0 = "no triangle here".

Vertex shader (outline):

```glsl
#version 300 es
in vec3 position;
in vec3 normal;
in vec4 skinIndex;
in vec4 skinWeight;
in uint aTriId;

flat out uint vTriId;

#include <common>
#include <skinning_pars_vertex>

void main() {
  vTriId = aTriId;
  #include <skinbase_vertex>
  vec4 mvPosition = vec4(position, 1.0);
  #include <skinning_vertex>
  gl_Position = projectionMatrix * modelViewMatrix * mvPosition;
}
```

Fragment shader:

```glsl
#version 300 es
precision highp float;
precision highp int;
flat in uint vTriId;
out uvec4 fragId;
void main() {
  fragId = uvec4(vTriId + 1u, 0u, 0u, 0u);
}
```

**Critical:** the skinning math here must match what the runtime produces. Because Three.js's skinning chunks are used, and the runtime renders skinned meshes from the same GLB data, this should hold. If validation discovers a discrepancy, the escape hatch is to evaluate skinning on the CPU in JS, write posed vertex positions to the geometry directly, and use a non-skinned shader for the bake. Slower but guaranteed-consistent. Decide based on §4 results.

### 2.5 Render target

A `THREE.WebGLRenderTarget` with:

- Size: `render_resolution.x * supersample` x `render_resolution.y * supersample`.
- Color texture: `{ type: THREE.UnsignedIntType, format: THREE.RedIntegerFormat, internalFormat: 'R32UI' }`.
- Depth: `THREE.DepthTexture` with `DepthFormat` / `UnsignedIntType`.
- `generateMipmaps: false`, `minFilter: NearestFilter`, `magFilter: NearestFilter`.

Verify `EXT_color_buffer_integer` / `EXT_color_buffer_float` availability at startup; abort with a clear error if unsupported (should be universally present in modern Chromium).

### 2.6 Sampling loop

**Camera sampler (`src/bake/cameraSampler.js`).** Generate K samples from a 3D Halton sequence (bases 2, 3, 5) mapped to (pitch, yaw, distance) within the ACS ranges. For each sample produce a `THREE.PerspectiveCamera` positioned on the spherical shell around `target_offset`, looking at `target_offset`, with `fov = horizontal_fov_deg` and `aspect = aspect_ratio`.

**Pose sampler (`src/bake/poseSampler.js`).** For each animation name in `pose_animations`, walk from t=0 to t=duration with step `(1 / animation_fps) * pose_sample_stride`. Collect all sample times across all named animations into one list. If the list length exceeds `p_poses`, subsample uniformly down to `p_poses`; if fewer, use all of them. Always include t=0 on the first animation (bind pose / idle start) as the first sample.

**Evaluating a pose.** For each pose, use the merged `SkinnedMesh`'s `AnimationMixer` (`mixer.setTime(t)` or equivalent) to pose the skeleton before rendering. The same mixer/timing path the runtime would use.

**Per-sample render.**

1. Pose the skeleton to pose P.
2. Point the renderer at the R32UI render target.
3. Clear to `(0, 0, 0, 0)` and depth=1.
4. Render the baking mesh (the triangle-duplicated geometry + the ID shader material) using camera K.
5. `renderer.readRenderTargetPixels(target, 0, 0, width, height, buffer)` into a `Uint32Array` of length `width * height`.
6. Walk the buffer; for each non-zero `id`, set bit `id - 1` in the visibility `Uint32Array` bitset.

Report progress every 16 samples: `Sample 432/1280, triangles seen so far: 7814/12847`.

### 2.7 Elimination

After all K x P samples:

1. Build a `kept[triangle_count]` boolean from the bitset.
2. Walk the merged geometry's index buffer in triangles; emit a new index buffer containing only kept triangles.
3. Walk the new index buffer; build a vertex remap `orig_vertex -> new_vertex` on the fly, copying referenced vertices into new attribute buffers; rewrite indices.
4. Rebuild geometry groups: for each original group, count how many of its triangles were kept and emit a new group with the corresponding range. Drop empty groups and their (now unused) materials.
5. Assign the new geometry to the merged `SkinnedMesh`; it is now the reduced mesh ready for export.

Record reduction stats into `userData.acscull.reductionStats` for the sidecar writer.

## 3. Output

### 3.1 Backup of prior `--out` and pre-reduction reference

Two separate concerns:

**Backup.** Before writing the reduced GLB, if `--out` points to an existing file, rename the existing `assets/player.glb` → `assets/player.original.glb` (or `.original-N.glb` if a prior backup exists, monotonically incrementing N). If `--out` does not exist, no backup. Backups are not overwritten on subsequent bakes; this protects against accidentally re-baking already-reduced input.

**Pre-reduction reference for validation.** The validation harness (§4.1) needs the merged-but-not-eliminated mesh as its baseline. The bake produces this in memory immediately after §1's merge step, so it is exposed via the optional `--save-merged <path>` flag. When set, the GLB at that path is the merge output before triangle elimination — same skeleton, same animations, just no triangles removed. Recommended convention: write `<asset>.glb` (pre-reduction) alongside `<asset>_reduced.glb` (reduced). The Android NDK game ships both and toggles between them at runtime; the validation harness consumes them as `--original` and `--reduced`.

### 3.2 GLB export

Use the existing `GLTFExporter` (same import as in `export_glb.js`). Export the reduced merged `SkinnedMesh` plus its skeleton and animations to the target path.

```js
const exporter = new GLTFExporter();
exporter.parse(
  reducedSkinnedMesh,
  (glb) => { fs.writeFileSync(outPath, Buffer.from(glb)); },
  (err) => { throw err; },
  { binary: true, animations: reducedSkinnedMesh.animations, includeCustomExtensions: false }
);
```

Do not embed ACSCull metadata as a glTF extension in v1 — keep it in the sidecar. Makes the GLB indistinguishable from a normal export from the game runtime's perspective.

### 3.3 Sidecar

Write `<outPath>.acsbake.json`:

```json
{
  "acscull_version": "0.1.0",
  "source_preset": "preset01.json",
  "source_parts": ["body_v3.fbx", "shirt_07.fbx", "pants_02.fbx", "hat_fedora.fbx", "sword_basic.fbx"],
  "acs": { },
  "k_cameras": 64,
  "p_poses_sampled": 20,
  "render_resolution": [512, 512],
  "supersample": 2,
  "original_triangle_count": 12847,
  "kept_triangle_count":     7562,
  "reduction_ratio":         0.411,
  "original_vertex_count":   8934,
  "kept_vertex_count":       5471,
  "vertex_reduction_ratio":  0.388,
  "bake_wall_time_s":   34.2,
  "device_fingerprint": "<WebGL RENDERER string>",
  "bake_timestamp":     "2026-04-24T03:47:12Z"
}
```

The `acs` field is the exact copy of the ACS JSON used. The sidecar is the minimum reproducibility record required for a bake to be citable.

## 4. Validation harness

A second headless entry point `validate.js`, paralleling `bake.js`:

```
npx electron validate.js --original assets/player.glb --reduced assets/player_reduced.glb --acs data/acs_default.json --out validation/player/
```

### 4.1 Inputs

- An original merged GLB — the pre-reduction reference produced by `bake.js --save-merged` (§3.1), or any equivalent merged-but-not-eliminated GLB.
- A reduced GLB — the bake's `--out`.
- An ACS JSON (usually the same one used for the bake).

### 4.2 Held-out cameras

Generate 128 cameras using a Halton sequence with **different bases** (7, 11, 13) than the bake's sampler (2, 3, 5), ensuring no sample coincidence. Distributed across the same ACS ranges.

### 4.3 Per-camera comparison

For each held-out camera:

1. Render the original GLB to framebuffer A using the normal viewer color shader.
2. Render the reduced GLB to framebuffer B using the same shader.
3. `readRenderTargetPixels` both into RGBA8 `Uint8Array` buffers.
4. Compute SSIM(A, B) — Wang et al. 2004 formulation, 11x11 Gaussian window, K1=0.01, K2=0.03, L=255. Implemented in `src/validate/ssim.js`, ~150 LOC.
5. Also compute max per-channel absolute difference.
6. Write a row to `validation_in_acs.csv`: `camera_index, pitch_deg, yaw_deg, distance, ssim, max_abs_diff`.

Pose for validation: t=0 (bind pose / first-animation-start) for v1. Can be extended per-pose later if reviewers request.

### 4.4 Adversarial test

Second pass with pitch extended by ±5°, distance extended by ±25%. 128 cameras. Output `validation_adversarial.csv`.

### 4.5 Summary

`validation_summary.json`:

```json
{
  "in_acs": {
    "ssim_mean": 0.9987,
    "ssim_p05":  0.9961,
    "ssim_min":  0.9923,
    "max_abs_diff_max": 14
  },
  "adversarial": {
    "ssim_mean": 0.9876,
    "ssim_p05":  0.9714,
    "ssim_min":  0.9612,
    "max_abs_diff_max": 41
  }
}
```

## 5. Repo layout

Additions to the existing viewer repo. Existing files (`renderer.js`, `export_glb.js`, etc.) are not modified in v1.

```
viewer/
├── bake.js                          (NEW - headless entry point)
├── validate.js                      (NEW - headless entry point)
├── src/
│   ├── bake/
│   │   ├── mergeSkinned.js          (NEW - section 1)
│   │   ├── acsConfig.js             (NEW - section 2.2 loader)
│   │   ├── cameraSampler.js         (NEW - section 2.6)
│   │   ├── poseSampler.js           (NEW - section 2.6)
│   │   ├── bakingGeometry.js        (NEW - section 2.3)
│   │   ├── bakeShaderMaterial.js    (NEW - section 2.4)
│   │   ├── visibilityPass.js        (NEW - section 2.5-2.6)
│   │   ├── triangleElimination.js   (NEW - section 2.7)
│   │   └── sidecarWriter.js         (NEW - section 3.3)
│   └── validate/
│       ├── heldOutCameras.js        (NEW - section 4.2)
│       ├── ssim.js                  (NEW - section 4.3)
│       └── validationRunner.js      (NEW - section 4.3-4.5)
├── tests/
│   ├── mergeSkinned.test.js         (NEW - section 1.6)
│   ├── bakingGeometry.test.js       (NEW)
│   └── ssim.test.js                 (NEW)
└── data/
    └── acs_default.json             (NEW)
```

No changes to the Android NDK game runtime in v1 — it consumes the reduced GLB at the same path it consumed the original, via the existing cgltf loader.

## 6. Milestones

Compressed from v0.1's three weeks because Three.js helpers and the existing headless entry-point pattern do meaningful work for us.

### Week 1 — Merge + bake scaffolding (~5 days)

- **Day 1:** `mergeSkinned.js` structure; skeleton verification; bind-space reconciliation math. Unit test skeleton.
- **Day 2:** `BufferGeometryUtils.mergeGeometries` integration; material assembly; groups; animation copy-through. First pass of `mergeSkinned.test.js`.
- **Day 3:** Bind-space reconciliation correctness — the critical step. SSIM check in the test against pre-merge rendering must pass >= 0.999 at bind pose and at t=0.5s.
- **Day 4:** `bake.js` headless entry point; ACS loader; scene setup; stub visibility pass; exits cleanly with placeholder output.
- **Day 5:** `bakingGeometry.js` — triangle-duplicated geometry with `aTriId`. Unit test validating triangle count and attribute preservation.

**Deliverable:** `npx electron bake.js --preset preset01.json --acs data/acs_default.json --out /tmp/test.glb` runs end-to-end, produces a GLB (identical to pre-bake for now — no elimination yet), prints stats.

### Week 2 — Visibility pass + elimination (~5 days)

- **Day 1:** `bakeShaderMaterial.js` — custom ShaderMaterial with Three.js skinning chunks + triangle-ID fragment. Single-camera-single-pose sanity render into R32UI, readback, print unique triangle IDs seen.
- **Day 2:** `cameraSampler.js` (Halton 2-3-5), `poseSampler.js` (stride + cap).
- **Day 3:** Full K x P sampling loop with progress reporting and visibility bitset accumulation. Performance sanity-check on a real asset; confirm bake wall time is tolerable (target under 5 min per character).
- **Day 4:** `triangleElimination.js` — index rewrite, vertex remap, group rebuild.
- **Day 5:** End-to-end integration. Backup logic (§3.1). GLTFExporter wiring. Sidecar writer. Run on a real character; visually inspect the reduced GLB in the existing viewer.

**Deliverable:** a fully-baked `player.glb` + `player.original.glb` + `player.glb.acsbake.json`. Loading the reduced GLB in the game runtime renders correctly.

### Week 3 — Validation + paper drafting (~5 days)

- **Day 1:** `heldOutCameras.js`, `ssim.js`, `ssim.test.js` (against a reference implementation in Python for correctness).
- **Day 2:** `validate.js` entry point; `validationRunner.js`; CSV + summary JSON writers.
- **Day 3:** Run validation on the full corpus (currently `player.glb`, `enemy.glb`; expand if more characters exist).
- **Day 4-5:** Paper draft sections 2 (method) and 3 (validation) from actual measurements.

**Deliverable:** validation CSVs + summary JSONs per character; first draft of MethodsX sections 2 and 3.

## 7. Open questions (deferred to v2)

- **Transparent / alpha-tested materials.** v1 treats all source materials as opaque for visibility purposes. Add MASK/BLEND handling in v2 by forcing those triangles into the visibility set unconditionally.
- **Skinning parity between bake and runtime.** If §4 validation shows SSIM < 0.995 on the in-ACS test, investigate whether Three.js's GPU skinning matches the game's cgltf skinning numerically. Escape hatch: CPU pose evaluation in JS, non-skinned bake shader.
- **Shadow-caster geometry.** v1 uses the reduced mesh for both camera and shadow rendering. If shadow artifacts appear in-game, fall back to original for shadows.
- **Interactive B-key bake mode.** Useful for iteration but not for shipping. Add in v2 if bake-time iteration becomes painful.
- **Atlas-batched readbacks.** Only if per-asset bake time exceeds 10 minutes.
- **Multi-ACS support.** Only if the game grows a second camera mode (photo mode, cinematic).

---

**Document ownership:** Jos.
**Review status:** awaiting first implementation pass; revise after Week 1 retrospective.
