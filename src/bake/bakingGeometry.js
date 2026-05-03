// SPEC.md v0.2 §2.3 — baking geometry construction.
//
// WebGL2 has no gl_PrimitiveID in fragment shaders, so each triangle's three
// vertices are duplicated and stamped with a per-vertex aTriId attribute
// (flat-interpolated in the bake shader). Bake-only: not exported.

const THREE = require('three');

function buildBakingGeometry(sourceGeometry) {
  if (!sourceGeometry || !sourceGeometry.isBufferGeometry) {
    throw new Error('buildBakingGeometry: sourceGeometry must be a BufferGeometry');
  }
  if (!sourceGeometry.index) {
    throw new Error('buildBakingGeometry: sourceGeometry must be indexed');
  }

  const srcIndex = sourceGeometry.index.array;
  const triangleCount = srcIndex.length / 3;
  if (!Number.isInteger(triangleCount)) {
    throw new Error('buildBakingGeometry: index count is not a multiple of 3');
  }
  const newVertexCount = triangleCount * 3;

  const out = new THREE.BufferGeometry();

  for (const name of Object.keys(sourceGeometry.attributes)) {
    const src = sourceGeometry.attributes[name];
    const itemSize = src.itemSize;
    const Ctor = src.array.constructor;
    const dst = new Ctor(newVertexCount * itemSize);
    const srcArr = src.array;

    for (let t = 0; t < triangleCount; t++) {
      const i0 = srcIndex[t * 3 + 0];
      const i1 = srcIndex[t * 3 + 1];
      const i2 = srcIndex[t * 3 + 2];
      const writeBase = t * 3 * itemSize;
      for (let c = 0; c < itemSize; c++) {
        dst[writeBase + 0 * itemSize + c] = srcArr[i0 * itemSize + c];
        dst[writeBase + 1 * itemSize + c] = srcArr[i1 * itemSize + c];
        dst[writeBase + 2 * itemSize + c] = srcArr[i2 * itemSize + c];
      }
    }

    out.setAttribute(name, new THREE.BufferAttribute(dst, itemSize, src.normalized));
  }

  const triIdArr = new Uint32Array(newVertexCount);
  for (let t = 0; t < triangleCount; t++) {
    triIdArr[t * 3 + 0] = t;
    triIdArr[t * 3 + 1] = t;
    triIdArr[t * 3 + 2] = t;
  }
  const triIdAttr = new THREE.BufferAttribute(triIdArr, 1, false);
  triIdAttr.gpuType = THREE.UnsignedIntType;
  out.setAttribute('aTriId', triIdAttr);

  const IdxCtor = newVertexCount < 65536 ? Uint16Array : Uint32Array;
  const outIdx = new IdxCtor(newVertexCount);
  for (let i = 0; i < newVertexCount; i++) outIdx[i] = i;
  out.setIndex(new THREE.BufferAttribute(outIdx, 1));

  // Source groups are ranges of the index buffer. Because the output index is
  // an identity mapping (triangle t -> vertices 3t..3t+2), {start, count} are
  // preserved verbatim.
  if (sourceGeometry.groups.length > 0) {
    for (const g of sourceGeometry.groups) {
      out.addGroup(g.start, g.count, g.materialIndex);
    }
  }

  return out;
}

module.exports = { buildBakingGeometry };
