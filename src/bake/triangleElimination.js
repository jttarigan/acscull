// SPEC.md v0.2 §2.7 — triangle elimination + vertex repack + group rebuild.

const THREE = require('three');

function eliminateTriangles(geometry, bitset, materials) {
  if (!geometry.index) {
    throw new Error('eliminateTriangles: geometry must be indexed');
  }
  const srcIdx = geometry.index.array;
  const srcTriCount = srcIdx.length / 3;

  const kept = new Uint8Array(srcTriCount);
  let keptCount = 0;
  for (let t = 0; t < srcTriCount; t++) {
    if ((bitset[t >>> 5] & (1 << (t & 31))) !== 0) {
      kept[t] = 1;
      keptCount++;
    }
  }

  const srcVertCount = geometry.getAttribute('position').count;
  const vertRemap = new Int32Array(srcVertCount);
  for (let i = 0; i < srcVertCount; i++) vertRemap[i] = -1;

  const newIndices = new Uint32Array(keptCount * 3);
  let newVertCount = 0;
  let w = 0;

  for (let t = 0; t < srcTriCount; t++) {
    if (!kept[t]) continue;
    for (let k = 0; k < 3; k++) {
      const srcVert = srcIdx[t * 3 + k];
      let nv = vertRemap[srcVert];
      if (nv === -1) {
        nv = newVertCount++;
        vertRemap[srcVert] = nv;
      }
      newIndices[w++] = nv;
    }
  }

  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(geometry.attributes)) {
    const src = geometry.attributes[name];
    const itemSize = src.itemSize;
    const Ctor = src.array.constructor;
    const dst = new Ctor(newVertCount * itemSize);

    for (let i = 0; i < srcVertCount; i++) {
      const nv = vertRemap[i];
      if (nv !== -1) {
        for (let c = 0; c < itemSize; c++) {
          dst[nv * itemSize + c] = src.array[i * itemSize + c];
        }
      }
    }
    const attr = new THREE.BufferAttribute(dst, itemSize, src.normalized);
    if (src.gpuType !== undefined) attr.gpuType = src.gpuType;
    out.setAttribute(name, attr);
  }

  const IdxCtor = newVertCount < 65536 ? Uint16Array : Uint32Array;
  const idxBuf = new IdxCtor(newIndices.length);
  for (let i = 0; i < newIndices.length; i++) idxBuf[i] = newIndices[i];
  out.setIndex(new THREE.BufferAttribute(idxBuf, 1));

  // Rebuild groups and compact the material list to only those still referenced.
  const oldGroups = geometry.groups.slice();
  const srcMaterialsArr = Array.isArray(materials) ? materials : (materials ? [materials] : []);
  const newMaterials = [];
  const materialRemap = new Map();

  function getRemappedIndex(oldMatIdx) {
    if (materialRemap.has(oldMatIdx)) return materialRemap.get(oldMatIdx);
    const newIdx = newMaterials.length;
    newMaterials.push(srcMaterialsArr[oldMatIdx]);
    materialRemap.set(oldMatIdx, newIdx);
    return newIdx;
  }

  if (oldGroups.length === 0) {
    if (newIndices.length > 0) {
      out.addGroup(0, newIndices.length, getRemappedIndex(0));
    }
  } else {
    let outStart = 0;
    for (const g of oldGroups) {
      const tStart = g.start / 3;
      const tEnd = (g.start + g.count) / 3;
      let keptInGroup = 0;
      for (let t = tStart; t < tEnd; t++) if (kept[t]) keptInGroup++;
      if (keptInGroup > 0) {
        const newMatIdx = getRemappedIndex(g.materialIndex);
        out.addGroup(outStart, keptInGroup * 3, newMatIdx);
        outStart += keptInGroup * 3;
      }
    }
  }

  return {
    geometry: out,
    materials: newMaterials,
    // Per-triangle keep bitmap, indexed by the merged geometry's triangle
    // index (0..srcTriCount-1). 1 = kept, 0 = culled. Used by CullViewer
    // to render the merged-original colored green/red.
    kept,
    stats: {
      originalTriangleCount: srcTriCount,
      keptTriangleCount: keptCount,
      reductionRatio: 1 - keptCount / srcTriCount,
      originalVertexCount: srcVertCount,
      keptVertexCount: newVertCount,
      vertexReductionRatio: 1 - newVertCount / srcVertCount,
      originalMaterialCount: srcMaterialsArr.length,
      keptMaterialCount: newMaterials.length,
    },
  };
}

module.exports = { eliminateTriangles };
