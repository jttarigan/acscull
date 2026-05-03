// SPEC.md v0.2 §1 — merge pass.
//
// Bind-space reconciliation (§1.3 step 2):
// The spec-as-written formula does not reproduce renderer.js::attachMesh's contract
// (world = bone.matrixWorld * attach.boneInverses[i] * attach.bindMatrix * v).
// Solving "skinned via base's bind info = skinned via attach's bind info" for v_merged:
//   delta_i = inv(base.bindMatrix) * inv(base.boneInverses[i])
//           * attach.boneInverses[i] * attach.bindMatrix
// Test §1.6 (SSIM vs. pre-merge render) is the correctness gate.

const THREE = require('three');
const BGU = require('three/examples/jsm/utils/BufferGeometryUtils.js');
const mergeGeometries = BGU.mergeGeometries || BGU.mergeBufferGeometries;

function mergeSkinned(baseModel, attachments = []) {
  if (!baseModel || typeof baseModel.traverse !== 'function') {
    throw new Error('mergeSkinned: baseModel must be an Object3D');
  }

  const attachmentSet = new Set(attachments);
  const baseSkinnedMeshes = [];
  baseModel.traverse(obj => {
    if (obj.isSkinnedMesh && obj.visible && !attachmentSet.has(obj)) {
      baseSkinnedMeshes.push(obj);
    }
  });
  if (baseSkinnedMeshes.length === 0) {
    throw new Error('mergeSkinned: no base SkinnedMesh found in baseModel');
  }

  const baseMesh = baseSkinnedMeshes[0];
  const baseSkeleton = baseMesh.skeleton;
  const baseBoneIndexByName = Object.create(null);
  for (let i = 0; i < baseSkeleton.bones.length; i++) {
    baseBoneIndexByName[baseSkeleton.bones[i].name] = i;
  }

  for (const a of attachments) {
    if (!a.isSkinnedMesh) {
      throw new Error(`mergeSkinned: attachment "${a.name || '?'}" is not a SkinnedMesh`);
    }
    for (const bone of a.skeleton.bones) {
      if (!(bone.name in baseBoneIndexByName)) {
        throw new Error(
          `mergeSkinned: bone "${bone.name}" in attachment "${a.name || '?'}" missing from base skeleton`
        );
      }
    }
  }

  baseModel.updateMatrixWorld(true);
  for (const a of attachments) a.updateMatrixWorld(true);

  const geometries = [];
  const materials = [];
  const sourceParts = [];
  let degenerateRemoved = 0;

  // mergeGeometries(useGroups=true) produces one group per input geometry with
  // materialIndex = input_index, overwriting any existing groups. So the
  // materials array must have exactly one entry per input geometry.
  for (const mesh of baseSkinnedMeshes) {
    const g = prepareBaseGeometry(mesh, baseSkeleton, baseBoneIndexByName);
    degenerateRemoved += filterDegenerateInPlace(g);
    geometries.push(g);
    materials.push(firstMaterial(mesh.material));
    sourceParts.push(mesh.name || 'base');
  }

  for (const mesh of attachments) {
    const g = reconcileAttachmentGeometry(mesh, baseMesh, baseSkeleton, baseBoneIndexByName);
    degenerateRemoved += filterDegenerateInPlace(g);
    geometries.push(g);
    materials.push(firstMaterial(mesh.material));
    sourceParts.push(mesh.name || 'attachment');
  }

  normalizeGeometries(geometries);

  const merged = mergeGeometries(geometries, true);
  if (!merged) {
    throw new Error('mergeSkinned: mergeGeometries returned null (attribute set mismatch)');
  }

  const skel = new THREE.Skeleton(
    baseSkeleton.bones.slice(),
    baseSkeleton.boneInverses.map(m => m.clone())
  );
  const mergedMesh = new THREE.SkinnedMesh(
    merged,
    materials.length === 1 ? materials[0] : materials
  );
  mergedMesh.name = 'merged_' + (baseMesh.name || 'character');
  mergedMesh.bind(skel, baseMesh.bindMatrix.clone());

  if (baseModel.animations && baseModel.animations.length > 0) {
    mergedMesh.animations = baseModel.animations;
  } else {
    for (const a of attachments) {
      if (a.animations && a.animations.length > 0) {
        console.warn('mergeSkinned: base has no animations; using attachment animations as fallback');
        mergedMesh.animations = a.animations;
        break;
      }
    }
  }

  const posCount = merged.getAttribute('position').count;
  const idxCount = merged.index ? merged.index.count : posCount;
  mergedMesh.userData.acscull = {
    sourceParts,
    mergeStats: {
      vertexCount: posCount,
      triangleCount: idxCount / 3,
      submeshCount: merged.groups.length,
      materialCount: Array.isArray(mergedMesh.material) ? mergedMesh.material.length : 1,
      degenerateRemoved,
    },
  };

  return mergedMesh;
}

function firstMaterial(m) {
  return Array.isArray(m) ? m[0] : m;
}

function prepareBaseGeometry(mesh, baseSkeleton, baseBoneIndexByName) {
  const geom = mesh.geometry.clone();
  if (mesh.skeleton !== baseSkeleton) {
    let needsRemap = false;
    const remap = new Array(mesh.skeleton.bones.length);
    for (let i = 0; i < mesh.skeleton.bones.length; i++) {
      const baseIdx = baseBoneIndexByName[mesh.skeleton.bones[i].name];
      if (baseIdx === undefined) {
        throw new Error(`prepareBaseGeometry: bone "${mesh.skeleton.bones[i].name}" not in base`);
      }
      remap[i] = baseIdx;
      if (baseIdx !== i) needsRemap = true;
    }
    if (needsRemap) remapSkinIndex(geom, remap);
  }
  return geom;
}

function reconcileAttachmentGeometry(attachMesh, baseMesh, baseSkeleton, baseBoneIndexByName) {
  const geom = attachMesh.geometry.clone();
  const attachSkel = attachMesh.skeleton;

  const invBaseBind = new THREE.Matrix4().copy(baseMesh.bindMatrix).invert();
  const deltas = new Array(attachSkel.bones.length);
  const attachToBase = new Array(attachSkel.bones.length);

  for (let i = 0; i < attachSkel.bones.length; i++) {
    const baseIdx = baseBoneIndexByName[attachSkel.bones[i].name];
    attachToBase[i] = baseIdx;
    const invBaseInv = new THREE.Matrix4().copy(baseSkeleton.boneInverses[baseIdx]).invert();
    const d = new THREE.Matrix4();
    d.copy(invBaseBind)
      .multiply(invBaseInv)
      .multiply(attachSkel.boneInverses[i])
      .multiply(attachMesh.bindMatrix);
    deltas[i] = d;
  }

  const position = geom.getAttribute('position');
  const normal = geom.getAttribute('normal');
  const tangent = geom.getAttribute('tangent');
  const skinIndex = geom.getAttribute('skinIndex');
  const skinWeight = geom.getAttribute('skinWeight');

  if (!position || !skinIndex || !skinWeight) {
    throw new Error('reconcileAttachmentGeometry: missing position/skinIndex/skinWeight');
  }

  const vCount = position.count;
  const posArr = position.array;
  const normArr = normal ? normal.array : null;
  const tanArr = tangent ? tangent.array : null;
  const siArr = skinIndex.array;
  const swArr = skinWeight.array;

  const blended = new THREE.Matrix4();
  const normalMat = new THREE.Matrix3();
  const tmp = new THREE.Vector3();

  for (let v = 0; v < vCount; v++) {
    const si0 = siArr[v * 4 + 0], si1 = siArr[v * 4 + 1];
    const si2 = siArr[v * 4 + 2], si3 = siArr[v * 4 + 3];
    const w0 = swArr[v * 4 + 0], w1 = swArr[v * 4 + 1];
    const w2 = swArr[v * 4 + 2], w3 = swArr[v * 4 + 3];

    const be = blended.elements;
    for (let k = 0; k < 16; k++) be[k] = 0;
    if (w0 > 0) addScaled(be, deltas[si0].elements, w0);
    if (w1 > 0) addScaled(be, deltas[si1].elements, w1);
    if (w2 > 0) addScaled(be, deltas[si2].elements, w2);
    if (w3 > 0) addScaled(be, deltas[si3].elements, w3);

    const wSum = w0 + w1 + w2 + w3;
    if (wSum > 1e-6 && Math.abs(wSum - 1) > 1e-5) {
      const inv = 1 / wSum;
      for (let k = 0; k < 16; k++) be[k] *= inv;
    }

    tmp.set(posArr[v * 3 + 0], posArr[v * 3 + 1], posArr[v * 3 + 2]).applyMatrix4(blended);
    posArr[v * 3 + 0] = tmp.x;
    posArr[v * 3 + 1] = tmp.y;
    posArr[v * 3 + 2] = tmp.z;

    if (normArr) {
      normalMat.getNormalMatrix(blended);
      tmp.set(normArr[v * 3 + 0], normArr[v * 3 + 1], normArr[v * 3 + 2])
        .applyMatrix3(normalMat)
        .normalize();
      normArr[v * 3 + 0] = tmp.x;
      normArr[v * 3 + 1] = tmp.y;
      normArr[v * 3 + 2] = tmp.z;
    }
    if (tanArr) {
      tmp.set(tanArr[v * 4 + 0], tanArr[v * 4 + 1], tanArr[v * 4 + 2])
        .transformDirection(blended)
        .normalize();
      tanArr[v * 4 + 0] = tmp.x;
      tanArr[v * 4 + 1] = tmp.y;
      tanArr[v * 4 + 2] = tmp.z;
    }

    siArr[v * 4 + 0] = attachToBase[si0];
    siArr[v * 4 + 1] = attachToBase[si1];
    siArr[v * 4 + 2] = attachToBase[si2];
    siArr[v * 4 + 3] = attachToBase[si3];
  }

  position.needsUpdate = true;
  if (normal) normal.needsUpdate = true;
  if (tangent) tangent.needsUpdate = true;
  skinIndex.needsUpdate = true;

  return geom;
}

function addScaled(out, src, s) {
  for (let k = 0; k < 16; k++) out[k] += s * src[k];
}

function remapSkinIndex(geom, remap) {
  const si = geom.getAttribute('skinIndex');
  if (!si) return;
  const arr = si.array;
  for (let i = 0; i < arr.length; i++) arr[i] = remap[arr[i]];
  si.needsUpdate = true;
}

function normalizeGeometries(geometries) {
  const required = ['position', 'normal', 'uv', 'skinIndex', 'skinWeight'];
  const optional = ['tangent', 'color', 'uv2'];

  const keepOpt = {};
  for (const n of optional) keepOpt[n] = geometries.every(g => g.getAttribute(n));
  const keep = new Set([...required, ...optional.filter(n => keepOpt[n])]);

  for (const g of geometries) {
    for (const n of Object.keys(g.attributes)) {
      if (!keep.has(n)) g.deleteAttribute(n);
    }
    for (const n of required) {
      if (!g.getAttribute(n)) {
        throw new Error(`normalizeGeometries: missing required attribute "${n}"`);
      }
    }
    if (!g.index) {
      const count = g.getAttribute('position').count;
      const Ctor = count < 65536 ? Uint16Array : Uint32Array;
      const idx = new Ctor(count);
      for (let i = 0; i < count; i++) idx[i] = i;
      g.setIndex(new THREE.BufferAttribute(idx, 1));
    }
  }
}

function filterDegenerateInPlace(geometry) {
  if (!geometry.index) return 0;
  const idx = geometry.index.array;
  const Ctor = idx.constructor;

  const hadGroups = geometry.groups.length > 0;
  const oldGroups = hadGroups
    ? geometry.groups.slice()
    : [{ start: 0, count: idx.length, materialIndex: 0 }];

  const out = new Ctor(idx.length);
  let w = 0;
  let removed = 0;
  const newGroups = [];

  for (const g of oldGroups) {
    const gStart = w;
    const end = g.start + g.count;
    for (let t = g.start; t < end; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      if (a === b || b === c || a === c) {
        removed++;
        continue;
      }
      out[w++] = a;
      out[w++] = b;
      out[w++] = c;
    }
    const gCount = w - gStart;
    if (gCount > 0) newGroups.push({ start: gStart, count: gCount, materialIndex: g.materialIndex });
  }

  if (removed > 0) {
    geometry.setIndex(new THREE.BufferAttribute(out.slice(0, w), 1));
    if (hadGroups) {
      geometry.clearGroups();
      for (const g of newGroups) geometry.addGroup(g.start, g.count, g.materialIndex);
    }
  }
  return removed;
}

module.exports = { mergeSkinned };
