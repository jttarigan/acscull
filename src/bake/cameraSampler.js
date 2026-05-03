// SPEC.md v0.2 §2.6 — Halton camera sampler over the ACS.
//
// Generates K PerspectiveCameras using a 3D Halton sequence with bases
// (2, 3, 5) mapped to (pitch, yaw, distance). Low-discrepancy distribution
// gives better ACS coverage at small K than uniform random would.

const THREE = require('three');

function halton(index, base) {
  let result = 0;
  let fraction = 1 / base;
  let i = index;
  while (i > 0) {
    result += (i % base) * fraction;
    i = Math.floor(i / base);
    fraction /= base;
  }
  return result;
}

function sampleCameras(acs, count, bases) {
  const b = bases || [2, 3, 5];
  const cameras = [];
  const [tx, ty, tz] = acs.target_offset;
  const target = new THREE.Vector3(tx, ty, tz);

  for (let i = 0; i < count; i++) {
    const h0 = halton(i + 1, b[0]);
    const h1 = halton(i + 1, b[1]);
    const h2 = halton(i + 1, b[2]);

    const pitchDeg = acs.pitch_min_deg + h0 * (acs.pitch_max_deg - acs.pitch_min_deg);
    const yawDeg = acs.yaw_min_deg + h1 * (acs.yaw_max_deg - acs.yaw_min_deg);
    const dist = acs.distance_min + h2 * (acs.distance_max - acs.distance_min);

    const pitchRad = (pitchDeg * Math.PI) / 180;
    const yawRad = (yawDeg * Math.PI) / 180;

    const cam = new THREE.PerspectiveCamera(
      acs.horizontal_fov_deg,
      acs.aspect_ratio,
      0.1,
      Math.max(1000, acs.distance_max * 4)
    );
    cam.position.set(
      target.x + dist * Math.cos(pitchRad) * Math.sin(yawRad),
      target.y + dist * Math.sin(pitchRad),
      target.z + dist * Math.cos(pitchRad) * Math.cos(yawRad)
    );
    cam.lookAt(target);
    cam.updateMatrixWorld(true);
    cam.userData.acsSample = { pitchDeg, yawDeg, dist };
    cameras.push(cam);
  }
  return cameras;
}

module.exports = { sampleCameras, halton };
