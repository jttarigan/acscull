// SPEC.md v0.2 §2.4 — bake triangle-ID shader material.
//
// Writes per-fragment `uvec4(triangleId + 1, 0, 0, 0)` to a R32UI render
// target. RawShaderMaterial (not ShaderMaterial) because the default
// ShaderMaterial prefix declares `layout(location=0) out vec4 pc_fragColor`
// which conflicts with our uvec4 output.
//
// Skinning is hand-rolled to match Three.js's skinning_pars_vertex /
// skinbase_vertex / skinning_vertex chunks bit-for-bit. bindMatrix,
// bindMatrixInverse, and boneTexture must be set per-mesh via onBeforeRender
// (see attachBakeUniformHooks).

const THREE = require('three');

const VERTEX_SHADER = `precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 position;
in vec4 skinIndex;
in vec4 skinWeight;
in uint aTriId;

uniform mat4 modelMatrix;
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 bindMatrix;
uniform mat4 bindMatrixInverse;
uniform highp sampler2D boneTexture;

flat out uint vTriId;

mat4 getBoneMatrix(const in float i) {
  int size = textureSize(boneTexture, 0).x;
  int j = int(i) * 4;
  int x = j % size;
  int y = j / size;
  vec4 v1 = texelFetch(boneTexture, ivec2(x, y), 0);
  vec4 v2 = texelFetch(boneTexture, ivec2(x + 1, y), 0);
  vec4 v3 = texelFetch(boneTexture, ivec2(x + 2, y), 0);
  vec4 v4 = texelFetch(boneTexture, ivec2(x + 3, y), 0);
  return mat4(v1, v2, v3, v4);
}

void main() {
  vTriId = aTriId;

  mat4 boneMatX = getBoneMatrix(skinIndex.x);
  mat4 boneMatY = getBoneMatrix(skinIndex.y);
  mat4 boneMatZ = getBoneMatrix(skinIndex.z);
  mat4 boneMatW = getBoneMatrix(skinIndex.w);

  vec4 skinVertex = bindMatrix * vec4(position, 1.0);
  vec4 skinned = vec4(0.0);
  skinned += boneMatX * skinVertex * skinWeight.x;
  skinned += boneMatY * skinVertex * skinWeight.y;
  skinned += boneMatZ * skinVertex * skinWeight.z;
  skinned += boneMatW * skinVertex * skinWeight.w;

  vec3 transformed = (bindMatrixInverse * skinned).xyz;

  gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
}
`;

const FRAGMENT_SHADER = `precision highp float;
precision highp int;

flat in uint vTriId;
layout(location = 0) out uvec4 fragId;

void main() {
  fragId = uvec4(vTriId + 1u, 0u, 0u, 0u);
}
`;

function buildBakeShaderMaterial() {
  const mat = new THREE.RawShaderMaterial({
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    glslVersion: THREE.GLSL3,
    uniforms: {
      bindMatrix: { value: new THREE.Matrix4() },
      bindMatrixInverse: { value: new THREE.Matrix4() },
      boneTexture: { value: null },
    },
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
  });
  mat.name = 'AcsCullBakeShader';
  return mat;
}

// Wire a SkinnedMesh to update the bake material's skinning uniforms from
// the mesh's own skeleton on every render.
function attachBakeUniformHooks(skinnedMesh, material) {
  skinnedMesh.onBeforeRender = function (renderer, scene, camera, geometry, mat) {
    mat.uniforms.bindMatrix.value.copy(skinnedMesh.bindMatrix);
    mat.uniforms.bindMatrixInverse.value.copy(skinnedMesh.bindMatrixInverse);
    const skel = skinnedMesh.skeleton;
    if (skel.boneTexture === null || skel.boneTexture === undefined) {
      if (typeof skel.computeBoneTexture === 'function') skel.computeBoneTexture();
    }
    skel.update();
    mat.uniforms.boneTexture.value = skel.boneTexture;
    mat.uniformsNeedUpdate = true;
  };
}

module.exports = { buildBakeShaderMaterial, attachBakeUniformHooks };
