// Unit test for src/bake/bakingGeometry.js per SPEC v0.2 Week 1 Day 5.
// Validates triangle count and attribute preservation against a hand-built
// two-triangle quad. Pure Node — no Electron needed.
//
// Run: node tests/bakingGeometry.test.js
// Exit: 0 = pass, 1 = fail.

const THREE = require('three');
const path = require('path');

const { buildBakingGeometry } = require(
  path.resolve(__dirname, '..', 'src', 'bake', 'bakingGeometry.js')
);

function makeQuadGeometry() {
  const g = new THREE.BufferGeometry();
  const positions = new Float32Array([
    0, 0, 0,  1, 0, 0,  1, 1, 0,  0, 1, 0,
  ]);
  const normals = new Float32Array([
    0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
  ]);
  const uvs = new Float32Array([
    0, 0,  1, 0,  1, 1,  0, 1,
  ]);
  const skinIndex = new Uint16Array([
    0, 0, 0, 0,
    1, 0, 0, 0,
    2, 0, 0, 0,
    3, 0, 0, 0,
  ]);
  const skinWeight = new Float32Array([
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
    1, 0, 0, 0,
  ]);
  const index = new Uint16Array([
    0, 1, 2,
    0, 2, 3,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setAttribute('skinIndex', new THREE.BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new THREE.BufferAttribute(skinWeight, 4));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  g.addGroup(0, 6, 0);
  return g;
}

const failures = [];
function check(cond, msg) {
  if (!cond) failures.push(msg);
}

const src = makeQuadGeometry();
const out = buildBakingGeometry(src);

check(out.getAttribute('position').count === 6,
  `position count: want 6, got ${out.getAttribute('position').count}`);
check(out.index.count === 6,
  `index count: want 6, got ${out.index.count}`);

const pos = out.getAttribute('position').array;
check(pos[0] === 0 && pos[1] === 0 && pos[2] === 0, 'tri0 v0 pos');
check(pos[3] === 1 && pos[4] === 0 && pos[5] === 0, 'tri0 v1 pos');
check(pos[6] === 1 && pos[7] === 1 && pos[8] === 0, 'tri0 v2 pos');
check(pos[9] === 0 && pos[10] === 0 && pos[11] === 0, 'tri1 v0 pos');
check(pos[12] === 1 && pos[13] === 1 && pos[14] === 0, 'tri1 v1 pos');
check(pos[15] === 0 && pos[16] === 1 && pos[17] === 0, 'tri1 v2 pos');

const triId = out.getAttribute('aTriId').array;
check(triId.length === 6, `aTriId length: got ${triId.length}`);
check(triId[0] === 0 && triId[1] === 0 && triId[2] === 0, 'tri0 aTriId');
check(triId[3] === 1 && triId[4] === 1 && triId[5] === 1, 'tri1 aTriId');

const norm = out.getAttribute('normal').array;
for (let v = 0; v < 6; v++) {
  check(norm[v * 3 + 0] === 0 && norm[v * 3 + 1] === 0 && norm[v * 3 + 2] === 1,
    `normal[${v}] preserved`);
}

const uv = out.getAttribute('uv').array;
check(uv[0] === 0 && uv[1] === 0, 'tri0 v0 uv');
check(uv[2] === 1 && uv[3] === 0, 'tri0 v1 uv');
check(uv[4] === 1 && uv[5] === 1, 'tri0 v2 uv');
check(uv[6] === 0 && uv[7] === 0, 'tri1 v0 uv');
check(uv[8] === 1 && uv[9] === 1, 'tri1 v1 uv');
check(uv[10] === 0 && uv[11] === 1, 'tri1 v2 uv');

const si = out.getAttribute('skinIndex').array;
check(si[0] === 0, 'tri0 v0 skinIndex');
check(si[4] === 1, 'tri0 v1 skinIndex');
check(si[8] === 2, 'tri0 v2 skinIndex');
check(si[12] === 0, 'tri1 v0 skinIndex');
check(si[16] === 2, 'tri1 v1 skinIndex');
check(si[20] === 3, 'tri1 v2 skinIndex');

const sw = out.getAttribute('skinWeight').array;
for (let v = 0; v < 6; v++) {
  check(sw[v * 4 + 0] === 1 && sw[v * 4 + 1] === 0 && sw[v * 4 + 2] === 0 && sw[v * 4 + 3] === 0,
    `skinWeight[${v}] preserved`);
}

check(out.groups.length === 1, 'groups count');
check(out.groups[0].start === 0 && out.groups[0].count === 6 && out.groups[0].materialIndex === 0,
  'group range preserved');

const idx = out.index.array;
for (let i = 0; i < 6; i++) {
  check(idx[i] === i, `index[${i}] is identity`);
}

const triIdAttr = out.getAttribute('aTriId');
check(triIdAttr.array instanceof Uint32Array, 'aTriId is Uint32Array');
check(triIdAttr.itemSize === 1, 'aTriId itemSize is 1');
check(triIdAttr.normalized === false, 'aTriId not normalized');
check(triIdAttr.gpuType === THREE.UnsignedIntType, 'aTriId gpuType is UnsignedIntType');

if (failures.length === 0) {
  console.log('bakingGeometry test: PASS (' + (19 + 12 + 6 + 6 + 3) + ' assertions)');
  process.exit(0);
} else {
  console.log('bakingGeometry test: FAIL');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
