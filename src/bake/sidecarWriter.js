// SPEC.md v0.2 §3.3 — sidecar JSON writer.

const fs = require('fs');

const ACSCULL_VERSION = '0.1.0';

function writeSidecar(sidecarPath, info) {
  const sidecar = {
    acscull_version: ACSCULL_VERSION,
    source_preset: info.sourcePreset || null,
    source_parts: info.sourceParts || [],
    acs: info.acs,
    k_cameras: info.acs.k_cameras,
    p_poses_sampled: info.pPosesSampled,
    render_resolution: info.acs.render_resolution,
    supersample: info.acs.supersample,
    original_triangle_count: info.originalTriangleCount,
    kept_triangle_count: info.keptTriangleCount,
    reduction_ratio: round(info.reductionRatio, 4),
    original_vertex_count: info.originalVertexCount,
    kept_vertex_count: info.keptVertexCount,
    vertex_reduction_ratio: round(info.vertexReductionRatio, 4),
    bake_wall_time_s: round(info.bakeWallTimeSeconds, 2),
    device_fingerprint: info.deviceFingerprint || null,
    bake_timestamp: new Date().toISOString(),
  };
  fs.writeFileSync(sidecarPath, JSON.stringify(sidecar, null, 2), 'utf-8');
  return sidecar;
}

function round(v, digits) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return v;
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

module.exports = { writeSidecar, ACSCULL_VERSION };
