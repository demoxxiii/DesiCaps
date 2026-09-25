#!/usr/bin/env bash
# Wrap dist/DesiCaps.app into a drag-to-Applications DMG.
set -euo pipefail
APP="dist/DesiCaps.app"
OUT="dist/DesiCaps-Mac-AppleSilicon.dmg"
STAGE="$(mktemp -d)"

# ad-hoc signature (required for Apple Silicon to launch unsigned apps at all)
codesign --force --deep --sign - "$APP"

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
cat > "$STAGE/READ ME FIRST.txt" <<'EOF'
DesiCaps Studio - first launch on a Mac

1. Drag DesiCaps into the Applications folder.
2. Open Applications, RIGHT-CLICK DesiCaps and choose "Open", then "Open" again.
   (macOS 15+: if there is no Open button, go to System Settings > Privacy & Security,
    scroll down and click "Open Anyway" next to DesiCaps.)

You only need to do this once. DesiCaps is free and runs fully offline.
EOF

rm -f "$OUT"
hdiutil create -volname "DesiCaps Studio" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
echo "Built $OUT"
