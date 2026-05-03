// SPEC.md v0.2 §2.6 — pose sampler.
//
// Matches clip names by case-insensitive substring against
// acs.pose_animations, walks each with step (1/fps) * pose_sample_stride,
// caps total samples at acs.p_poses while always retaining t=0 of the first
// matched clip as sample 0.

const FPS_ASSUMED = 30;

function samplePoses(clips, acs) {
  const matched = [];
  for (const clip of clips) {
    const n = clip.name.toLowerCase();
    if (acs.pose_animations.some(p => n.includes(p.toLowerCase()))) {
      matched.push(clip);
    }
  }

  if (matched.length === 0) {
    console.warn(
      'poseSampler: no clips matched pose_animations ' +
      JSON.stringify(acs.pose_animations) + '; using bind pose only'
    );
    return [{ clip: null, time: 0 }];
  }

  const dt = acs.pose_sample_stride / FPS_ASSUMED;
  const raw = [];
  raw.push({ clip: matched[0], time: 0 });
  for (const clip of matched) {
    const startT = clip === matched[0] ? dt : 0;
    for (let t = startT; t < clip.duration - 1e-6; t += dt) {
      raw.push({ clip, time: t });
    }
  }

  if (raw.length <= acs.p_poses) return raw;

  const out = [raw[0]];
  const rest = raw.slice(1);
  const target = acs.p_poses - 1;
  for (let i = 0; i < target; i++) {
    const idx = Math.floor(i * rest.length / target);
    out.push(rest[idx]);
  }
  return out;
}

module.exports = { samplePoses, FPS_ASSUMED };
