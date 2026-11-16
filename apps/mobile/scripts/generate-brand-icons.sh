#!/usr/bin/env bash
# Regenerates the withJZ Crew launcher, adaptive, monochrome, notification, splash and favicon
# PNGs from logo A (assets/brand/withjz-crew-a.svg). Needs rsvg-convert and the DejaVu Sans font.
# Run from anywhere: bash apps/mobile/scripts/generate-brand-icons.sh
set -euo pipefail

ASSETS="$(cd "$(dirname "$0")/../assets" && pwd)"
SRC="$ASSETS/brand/withjz-crew-a.svg"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

BG="#1f2937"
ACCENT="#5eead4"

# The logo's lettering, centred on (256, 271) in the 512 viewBox.
lettering() {
  local jz="$1" crew="$2"
  cat <<SVG
  <text x="256" y="300" text-anchor="middle" font-family="DejaVu Sans" font-weight="bold" font-size="210" fill="$jz" letter-spacing="-8">JZ</text>
  <text x="256" y="392" text-anchor="middle" font-family="DejaVu Sans" font-size="62" fill="$crew" letter-spacing="10">CREW</text>
SVG
}

# Legacy launcher / iOS icon: full-bleed square (the OS applies its own mask).
cat >"$TMP/icon.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="$BG"/>
$(lettering "#ffffff" "$ACCENT")
</svg>
SVG

# Adaptive foreground: lettering only, scaled into the 66/108 safe circle.
cat >"$TMP/adaptive.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <g transform="translate(256 256) scale(0.66) translate(-256 -271)">
$(lettering "#ffffff" "$ACCENT")
  </g>
</svg>
SVG

cat >"$TMP/background.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" fill="$BG"/>
</svg>
SVG

# Android 13+ themed icon: one opaque colour on transparent; the launcher tints it.
cat >"$TMP/monochrome.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <g transform="translate(256 256) scale(0.66) translate(-256 -271)">
$(lettering "#ffffff" "#ffffff")
  </g>
</svg>
SVG

# Status-bar icon: white "JZ" silhouette on transparent, drawn as a path so the native live
# notification drawable (modules/rakazo-notifications/.../ic_rakazo_notification.xml) can use
# the same pathData. Keep the two in sync (lib/brand-assets.test.ts checks it).
NOTIFICATION_GLYPH="M7.6,5H10.2V14.6C10.2,17.6 8.6,19.2 6,19.2C4.9,19.2 3.9,18.9 3.2,18.4L4.1,16.2C4.6,16.6 5.2,16.8 5.8,16.8C7,16.8 7.6,16.1 7.6,14.5ZM12.5,5H21V7.3L15.6,16.4H21.3V19H12.3V16.7L17.7,7.6H12.5Z"
cat >"$TMP/notification.svg" <<SVG
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">
  <path fill="#ffffff" d="$NOTIFICATION_GLYPH"/>
</svg>
SVG

rsvg-convert -w 1024 -h 1024 -b "$BG" "$TMP/icon.svg" -o "$ASSETS/icon.png"
rsvg-convert -w 1024 -h 1024 "$TMP/adaptive.svg" -o "$ASSETS/adaptive-icon.png"
rsvg-convert -w 1024 -h 1024 "$TMP/background.svg" -o "$ASSETS/icon-background.png"
rsvg-convert -w 1024 -h 1024 "$TMP/monochrome.svg" -o "$ASSETS/monochrome-icon.png"
rsvg-convert -w 96 -h 96 "$TMP/notification.svg" -o "$ASSETS/notification-icon.png"
# Splash and favicon use the logo as drawn (rounded tile).
rsvg-convert -w 1024 -h 1024 "$SRC" -o "$ASSETS/splash-icon.png"
rsvg-convert -w 128 -h 128 "$SRC" -o "$ASSETS/favicon.png"
# Play Console listing icon (512 px, full square, Google applies the mask). Not bundled.
rsvg-convert -w 512 -h 512 -b "$BG" "$TMP/icon.svg" -o "$ASSETS/brand/play-store-icon-512.png"

echo "Generated brand icons in $ASSETS"
