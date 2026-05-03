// SPEC.md v0.2 §2.2 — ACS JSON loader and validator.

const fs = require('fs');

const REQUIRED_FIELDS = [
  'version',
  'pitch_min_deg', 'pitch_max_deg',
  'yaw_min_deg', 'yaw_max_deg',
  'distance_min', 'distance_max',
  'horizontal_fov_deg', 'aspect_ratio',
  'target_offset',
  'k_cameras', 'p_poses',
  'supersample', 'render_resolution',
  'pose_animations', 'pose_sample_stride',
];

function loadAcsConfig(filePath) {
  const raw = fs.readFileSync(filePath, 'utf-8');
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`acsConfig: failed to parse ${filePath}: ${err.message}`);
  }
  validate(cfg, filePath);
  return cfg;
}

function validate(cfg, source) {
  for (const f of REQUIRED_FIELDS) {
    if (!(f in cfg)) {
      throw new Error(`acsConfig: missing field "${f}" in ${source}`);
    }
  }
  if (cfg.version !== 1) {
    throw new Error(`acsConfig: unsupported version ${cfg.version} (want 1)`);
  }
  assertRange(cfg, 'pitch_min_deg', 0, 90);
  assertRange(cfg, 'pitch_max_deg', 0, 90);
  if (cfg.pitch_min_deg > cfg.pitch_max_deg) {
    throw new Error('acsConfig: pitch_min_deg > pitch_max_deg');
  }
  assertNumber(cfg, 'yaw_min_deg');
  assertNumber(cfg, 'yaw_max_deg');
  if (cfg.yaw_min_deg > cfg.yaw_max_deg) {
    throw new Error('acsConfig: yaw_min_deg > yaw_max_deg');
  }
  if (!(cfg.distance_min > 0) || !(cfg.distance_max > 0)) {
    throw new Error('acsConfig: distance_min/distance_max must be > 0');
  }
  if (cfg.distance_min > cfg.distance_max) {
    throw new Error('acsConfig: distance_min > distance_max');
  }
  assertRange(cfg, 'horizontal_fov_deg', 1, 179);
  if (!(cfg.aspect_ratio > 0)) {
    throw new Error('acsConfig: aspect_ratio must be > 0');
  }
  if (!Array.isArray(cfg.target_offset) || cfg.target_offset.length !== 3
      || !cfg.target_offset.every(x => typeof x === 'number' && Number.isFinite(x))) {
    throw new Error('acsConfig: target_offset must be [x,y,z] of finite numbers');
  }
  assertPosInt(cfg, 'k_cameras');
  assertPosInt(cfg, 'p_poses');
  assertPosInt(cfg, 'supersample');
  if (!Array.isArray(cfg.render_resolution) || cfg.render_resolution.length !== 2
      || !cfg.render_resolution.every(x => Number.isInteger(x) && x > 0)) {
    throw new Error('acsConfig: render_resolution must be [width,height] of positive integers');
  }
  if (!Array.isArray(cfg.pose_animations)
      || !cfg.pose_animations.every(x => typeof x === 'string' && x.length > 0)) {
    throw new Error('acsConfig: pose_animations must be an array of non-empty strings');
  }
  assertPosInt(cfg, 'pose_sample_stride');
}

function assertNumber(cfg, key) {
  const v = cfg[key];
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new Error(`acsConfig: ${key} must be a finite number (got ${v})`);
  }
}

function assertRange(cfg, key, lo, hi) {
  assertNumber(cfg, key);
  const v = cfg[key];
  if (v < lo || v > hi) {
    throw new Error(`acsConfig: ${key} = ${v} out of range [${lo}, ${hi}]`);
  }
}

function assertPosInt(cfg, key) {
  const v = cfg[key];
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`acsConfig: ${key} must be a positive integer (got ${v})`);
  }
}

module.exports = { loadAcsConfig };
