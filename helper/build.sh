#!/bin/sh
# Builds "White Rabbit Helper.app" (Apple silicon and Intel, macOS 13+).
#
# A release build is what the install command downloads: signed with White
# Rabbit's Developer ID, carrying the provisioning profile that gives it its
# own keychain access group (where its device token lives), notarized and
# stapled, and zipped to public/safari/WhiteRabbitHelper.zip. It also writes
# src/lib/server/helper-release.json, the SHA-256 and signing team the install
# command checks the download against. Needs a Mac with Xcode; commit the zip
# and helper-release.json together, since Vercel can't build Swift.
#
#   SIGN_IDENTITY="Developer ID Application: … (TEAMID)" \
#   NOTARY_PROFILE=<the name given to xcrun notarytool store-credentials> \
#   helper/build.sh
#
# with the Developer ID provisioning profile for the App ID
# app.whiterabbit.helper at helper/WhiteRabbitHelper.provisionprofile (or
# PROFILE=<path>). It isn't a secret: every copy of the app carries it.
# helper/SIGNING.md has the one-time setup.
#
# DEBUG=1 helper/build.sh makes a development build instead: signed ad hoc,
# it pairs with any White Rabbit address (localhost too), reads
# WHITE_RABBIT_HELPER_DIR, WHITE_RABBIT_SAFARI_HISTORY,
# WHITE_RABBIT_HELPER_KEYCHAIN (a scratch keychain file) and
# WHITE_RABBIT_HELPER_CONFIRM (yes or no, in place of the pairing dialog), and
# keeps its token in the file-based keychain. It goes to
# build/WhiteRabbitHelper-debug.zip, never to public/, so it can't be served
# by mistake.
set -eu
cd "$(dirname "$0")"

BUNDLE_ID=app.whiterabbit.helper
OUT=build
APP="$OUT/White Rabbit Helper.app"
ZIP=../public/safari/WhiteRabbitHelper.zip
MANIFEST=../src/lib/server/helper-release.json
PROFILE="${PROFILE:-WhiteRabbitHelper.provisionprofile}"
FLAGS=""
if [ -n "${DEBUG:-}" ]; then
  ZIP=build/WhiteRabbitHelper-debug.zip
  FLAGS="-D DEBUG"
elif [ -z "${SIGN_IDENTITY:-}" ] || [ -z "${NOTARY_PROFILE:-}" ] || [ ! -f "$PROFILE" ]; then
  echo "A release build needs SIGN_IDENTITY, NOTARY_PROFILE and the provisioning profile (see helper/SIGNING.md). DEBUG=1 makes a development build." >&2
  exit 1
fi
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$(dirname "$ZIP")"

if [ -z "${DEBUG:-}" ]; then
  # A Developer ID profile (good on every Mac) for this App ID, from the signing identity's team.
  security cms -D -i "$PROFILE" > "$OUT/profile.plist"
  read_profile() { /usr/libexec/PlistBuddy -c "Print :$1" "$OUT/profile.plist" 2>/dev/null || true; }
  TEAM_ID="$(read_profile TeamIdentifier:0)"
  case "$TEAM_ID" in
    [A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9][A-Z0-9]) ;;
    *) echo "$PROFILE has no team." >&2; exit 1 ;;
  esac
  if [ "$(read_profile Entitlements:com.apple.application-identifier)" != "$TEAM_ID.$BUNDLE_ID" ] ||
    [ "$(read_profile Entitlements:com.apple.developer.team-identifier)" != "$TEAM_ID" ]; then
    echo "$PROFILE isn't for $BUNDLE_ID." >&2
    exit 1
  fi
  if [ "$(read_profile ProvisionsAllDevices)" != "true" ]; then
    echo "$PROFILE isn't a Developer ID profile." >&2
    exit 1
  fi
  case "$SIGN_IDENTITY" in
    "Developer ID Application:"*"($TEAM_ID)") ;;
    *) echo "SIGN_IDENTITY must be team $TEAM_ID's Developer ID Application identity." >&2; exit 1 ;;
  esac
  echo "Profile for $TEAM_ID.$BUNDLE_ID, good until $(read_profile ExpirationDate)."
fi

for arch in arm64 x86_64; do
  # shellcheck disable=SC2086
  xcrun swiftc -O -swift-version 5 $FLAGS -target "$arch-apple-macos13.0" \
    -o "$OUT/WhiteRabbitHelper-$arch" Sources/*.swift -lsqlite3
done
lipo -create -output "$APP/Contents/MacOS/WhiteRabbitHelper" "$OUT/WhiteRabbitHelper-arm64" "$OUT/WhiteRabbitHelper-x86_64"
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

if [ -n "${DEBUG:-}" ]; then
  codesign --force --options runtime --sign - "$APP"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
  echo "Built $ZIP"
  exit 0
fi

# Its application identifier, which the profile authorizes, is its keychain access group.
cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
cat > "$OUT/entitlements.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.application-identifier</key><string>$TEAM_ID.$BUNDLE_ID</string>
  <key>com.apple.developer.team-identifier</key><string>$TEAM_ID</string>
</dict>
</plist>
EOF
codesign --force --options runtime --timestamp --entitlements "$OUT/entitlements.plist" --sign "$SIGN_IDENTITY" "$APP"
# The same check the install command makes (signedRequirement in src/lib/server/helper-scripts.ts).
SIGNED="anchor apple generic and identifier \"$BUNDLE_ID\" and certificate leaf[subject.OU] = \"$TEAM_ID\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists"
codesign --verify --strict --deep -R="$SIGNED" "$APP"
# macOS kills an app whose entitlements its profile doesn't authorize, so run it once.
if ! "$APP/Contents/MacOS/WhiteRabbitHelper" about | grep -q "its own keychain access group"; then
  echo "The signed app didn't start with its keychain access group; check the profile." >&2
  exit 1
fi

ditto -c -k --keepParent "$APP" "$OUT/notarize.zip"
xcrun notarytool submit "$OUT/notarize.zip" --keychain-profile "$NOTARY_PROFILE" --wait --output-format json > "$OUT/notary.json"
if ! grep -q '"status" *: *"Accepted"' "$OUT/notary.json"; then
  cat "$OUT/notary.json" >&2
  echo >&2
  echo "Notarization wasn't accepted; xcrun notarytool log <id> --keychain-profile $NOTARY_PROFILE says why." >&2
  exit 1
fi
xcrun stapler staple "$APP"
spctl --assess --type execute -vv "$APP"

rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
cat > "$MANIFEST" <<EOF
{
  "version": "$(plutil -extract CFBundleShortVersionString raw -o - Info.plist)",
  "teamId": "$TEAM_ID",
  "sha256": "$(shasum -a 256 "$ZIP" | cut -d ' ' -f 1)"
}
EOF
echo "Built $ZIP and $MANIFEST. Commit them together."
