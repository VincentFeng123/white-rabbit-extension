#!/bin/sh
# Builds "White Rabbit Helper.app" (Apple silicon and Intel, macOS 13+) and
# zips it to public/safari/WhiteRabbitHelper.zip, which the install command
# downloads. Needs a Mac with Xcode; commit the zip, since Vercel can't build
# Swift.
#
# Signed ad hoc by default, which is all the install command needs (curl
# doesn't quarantine what it downloads). To offer it as a plain download
# instead, sign and notarize: SIGN_IDENTITY="Developer ID Application: …"
# NOTARY_PROFILE=<xcrun notarytool store-credentials profile> helper/build.sh
#
# DEBUG=1 helper/build.sh makes a development build instead: it pairs with any
# White Rabbit address (localhost too) and reads WHITE_RABBIT_HELPER_DIR and
# WHITE_RABBIT_SAFARI_HISTORY. It goes to build/WhiteRabbitHelper-debug.zip,
# never to public/, so it can't be served by mistake.
set -eu
cd "$(dirname "$0")"

OUT=build
APP="$OUT/White Rabbit Helper.app"
ZIP=../public/safari/WhiteRabbitHelper.zip
FLAGS=""
if [ -n "${DEBUG:-}" ]; then
  ZIP=build/WhiteRabbitHelper-debug.zip
  FLAGS="-D DEBUG"
fi
rm -rf "$OUT"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources" "$(dirname "$ZIP")"

for arch in arm64 x86_64; do
  # shellcheck disable=SC2086
  xcrun swiftc -O -swift-version 5 $FLAGS -target "$arch-apple-macos13.0" \
    -o "$OUT/WhiteRabbitHelper-$arch" Sources/*.swift -lsqlite3
done
lipo -create -output "$APP/Contents/MacOS/WhiteRabbitHelper" "$OUT/WhiteRabbitHelper-arm64" "$OUT/WhiteRabbitHelper-x86_64"
cp Info.plist "$APP/Contents/Info.plist"
cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"

if [ -n "${SIGN_IDENTITY:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$SIGN_IDENTITY" "$APP"
else
  codesign --force --options runtime --sign - "$APP"
fi

rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"
if [ -n "${SIGN_IDENTITY:-}" ] && [ -n "${NOTARY_PROFILE:-}" ]; then
  xcrun notarytool submit "$ZIP" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$APP"
  rm -f "$ZIP"
  ditto -c -k --keepParent "$APP" "$ZIP"
fi
echo "Built $ZIP"
