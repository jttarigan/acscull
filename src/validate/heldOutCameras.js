// SPEC.md v0.2 §4.2, §4.4 — held-out camera samplers.
//
// Uses Halton bases (7, 11, 13) — distinct from the bake's (2, 3, 5) so no
// camera coincides with one that contributed to the visibility set.

const THREE = require('three');
const path = require('path');
const { halton } = require(path.resolve(__dirname, '..', 'bake', 'cameraSampler.js'));

const HELD_OUT_BASES = [7, 11, 13];

function sampleHeldOutCameras(acs, count) {
  return buildCameras(acs, count, HELD_OUT_BASES);
}

function sampleAdversarialCameras(acs, count) {
  const adv = Object.assign({}, acs, {
    pitch_min_deg: Math.max(0, acs.pitch_min_deg - 5),
    pitch_max_deg: Math.min(90, acs.pitch_max_deg + 5),
    distance_min: acs.distance_min * 0.75,
    distance_max: acs.distance_max * 1.25,
  });
  return buildCameras(adv, count, HELD_OUT_BASES);
}

function buildCameras(acs, count, bases) {
  const cams = [];
  const [tx, ty, tz] = acs.target_offset;
  const target = new THREE.Vector3(tx, ty, tz);
  for (let i = 0; i < count; i++) {
    const h0 = halton(i + 1, bases[0]);
    const h1 = halton(i + 1, bases[1]);
    const h2 = halton(i + 1, bases[2]);

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
    cams.push(cam);
  }
  return cams;
}

module.exports = { sampleHeldOutCameras, sampleAdversarialCameras, HELD_OUT_BASES };
