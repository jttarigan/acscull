#!/usr/bin/env bash
# Fetch Khronos sample assets into examples/ as ready-to-cull bundles.
# Run from the acscull/ root: bash examples/fetch_samples.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
SAMPLES_BASE="https://raw.githubusercontent.com/KhronosGroup/glTF-Sample-Assets/main/Models"

fetch() {
  local model_dir="$1"
  local glb_subpath="$2"
  local target_dir="$ROOT/$model_dir"
  mkdir -p "$target_dir"
  echo "→ $model_dir"
  if [ -f "$target_dir/character.glb" ]; then
    echo "  (already present, skipping)"
    return
  fi
  curl -fsSL --output "$target_dir/character.glb" "$SAMPLES_BASE/$glb_subpath"
  echo "  ✓ $target_dir/character.glb"
}

# Skinned + animated samples suitable for ACSCull
# - Fox: 4 idle/walk/run clips, ~3K tris, CC-BY 4.0 (preserve attribution)
fetch "fox" "Fox/glTF-Binary/Fox.glb"

# Write bundle.json manifests (clip filter + ACS overrides as needed)
cat > "$ROOT/fox/bundle.json" <<'JSON'
{
  "version": 1,
  "name": "fox",
  "description": "Khronos Fox sample (CC-BY 4.0). Has Survey/Walk/Run clips.",
  "clipFilter": ["survey", "walk", "run", "idle"]
}
JSON
echo "  ✓ $ROOT/fox/bundle.json"

echo ""
echo "Done. Try: npx electron cull.js --bundle examples/fox"
echo ""
echo "Khronos Sample Assets are CC-BY 4.0 — preserve attribution if redistributing."
