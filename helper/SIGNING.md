# Signing White Rabbit Helper

A release build of the Helper is signed with White Rabbit's Developer ID,
carries a Developer ID provisioning profile, and is notarized by Apple.
`helper/build.sh` refuses to make a release build without all three, and the
install command refuses a download that doesn't have them.

- **Why the profile:** it authorizes the app's application identifier
  (`FSRF52G5UF.app.whiterabbit.helper`), which is its access group in the
  data protection keychain. The Helper keeps its device token there, where no
  other program can read, replace, or delete it. Without the profile, the
  token would have to sit in a file or in the older file-based keychain, and
  any program running as the person could swap in a token for its own
  account. The Helper's Full Disk Access would then send that person's
  Safari history to the other account.
- **Why notarization:** `curl` doesn't mark what it downloads for
  Gatekeeper. The install script runs `spctl --assess` itself, and that only
  passes for notarized apps Apple hasn't revoked.

## One-time setup

Do these once, as the account holder of team FSRF52G5UF.

1. **App ID.** In [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list),
   add an Identifier: *App IDs* → *App*, description "White Rabbit Helper",
   explicit Bundle ID `app.whiterabbit.helper`. It needs no capabilities.
2. **Profile.** Under *Profiles*, add one: *Distribution* → *Developer ID*,
   App ID `app.whiterabbit.helper`, certificate *Developer ID Application:
   Account Holder Name*. Name it "White Rabbit Helper", download it, and save it as
   `helper/WhiteRabbitHelper.provisionprofile`. Commit it: every copy of the
   app carries it, so it isn't a secret. Developer ID profiles are good for
   18 years, and `build.sh` prints the date.
3. **Notarization credentials.** Make an app-specific password at
   [account.apple.com](https://account.apple.com) (Sign-In and Security →
   App-Specific Passwords), then store it in your keychain under a name:

   ```bash
   xcrun notarytool store-credentials white-rabbit-notary --apple-id <your Apple ID email> --team-id FSRF52G5UF
   ```

## Each release

1. Bump `CFBundleShortVersionString` and `CFBundleVersion` in
   `helper/Info.plist`. The uninstall script uses `CFBundleVersion` ≥ 2 to know
   the Helper has an `unpair` command.
2. Build:

   ```bash
   SIGN_IDENTITY="Developer ID Application: Account Holder Name (FSRF52G5UF)" NOTARY_PROFILE=white-rabbit-notary helper/build.sh
   ```

   The first time, macOS asks whether `codesign` may use the Developer ID key
   in your keychain. Choose Always Allow.
3. Commit `public/safari/WhiteRabbitHelper.zip` and
   `src/lib/server/helper-release.json` together. The install script checks
   the zip's SHA-256 against helper-release.json, so a zip without its
   manifest won't install. `src/lib/server/helper-scripts.test.ts` fails if
   they don't match.

## What it protects, and what it doesn't

- Other programs running as the person can't read, change, or delete the
  token. Only code signed by team FSRF52G5UF with a profile for this App ID
  can open that keychain access group.
- They can't hand the Helper another account by running
  `WhiteRabbitHelper pair` either. Pairing shows the account's email in a
  dialog, which only the person can click (clicking for them takes
  Accessibility permission). It's still up to the person to read it.
- They can't swap the app for a modified one and keep its Full Disk Access.
  macOS ties that grant to the signature. Hardened runtime stops them loading
  code into the real app.
- A copy of 1.0, which was signed ad hoc, keeps any Full Disk Access granted
  to it. The install script resets that grant when it replaces an unsigned
  copy, and the uninstall script resets it too.
- Nothing on the Mac protects against a program with administrator rights,
  or one the person has given Accessibility or Full Disk Access to.
- The install check catches a zip that was swapped, stale, or damaged on its
  own. It can't catch a takeover of the site that serves the script.
