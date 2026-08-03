#!/usr/bin/env bash
# Rebuilds smartoneg.com/demo/ as a static, no-backend snapshot of the real app.
# Copies the frontend from public/, the browser-safe engine modules from server/,
# and rewrites absolute asset paths so everything works under /demo/. The demo
# runtime (demo-boot.js, demo-seed.js, the index.html additions) is preserved.
# Lives in scripts/ (git-ignored). Run from anywhere: bash scripts/build-demo.sh
set -euo pipefail
cd "$(dirname "$0")/.."   # repo root
DEMO=smartoneg.com/demo

echo "→ snapshotting frontend into $DEMO/app"
rm -rf "$DEMO/app" "$DEMO/engine"
mkdir -p "$DEMO/app" "$DEMO/engine"
cp -r public/js "$DEMO/app/js"
cp -r public/css "$DEMO/app/css"
cp -r public/icons "$DEMO/app/icons"

echo "→ copying browser-safe engine modules"
for f in calendar/CalendarService.js calendar/dayTypes.js engine/TimelineCompiler.js \
         engine/SceneRepository.js engine/ConflictDetector.js engine/references.js engine/awayMode.js; do
  mkdir -p "$DEMO/engine/$(dirname "$f")"
  cp "server/$f" "$DEMO/engine/$f"
done

echo "→ rewriting absolute asset paths (/icons → /demo/app/icons)"
# only the frontend copy; leave /api alone (the demo fetch shim intercepts it).
# perl -pi is used instead of sed -i so this runs the same on macOS (BSD sed)
# and the Ubuntu CI runner (GNU sed), whose -i flags are incompatible.
find "$DEMO/app" -type f \( -name '*.js' -o -name '*.css' \) -print0 | while IFS= read -r -d '' file; do
  perl -pi -e "s{'/icons/}{'/demo/app/icons/}g; s{\"/icons/}{\"/demo/app/icons/}g" "$file"
  # neutralize service-worker registration in the demo
  perl -pi -e "s{\Qnavigator.serviceWorker.register('/sw.js')\E}{Promise.reject('demo')}g" "$file"
done

echo "✓ demo rebuilt"
