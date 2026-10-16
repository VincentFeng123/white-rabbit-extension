# White Rabbit extension

The parts of [White Rabbit](https://www.whiterabbt.com) that run on your computer: the browser extension that notices when you go down a rabbit hole, and White Rabbit Helper, which does the same for Safari on a Mac. They're public so you can read exactly what they do with your browsing, and check that what's in the store was built from this code.

## What the extension reads, and where it goes

- It records the pages you open in normal browser windows: each page's address, title, when you were there, and which page led to which. It never runs in incognito or private windows.
- Pages on sites you exclude, in the categories it skips (banking, health, email, work tools, password managers, adult), and sign-in, account and checkout pages are dropped before anything is stored. It keeps a week at most, on your computer.
- Every address is cleaned before it's stored ([`src/lib/capture/clean-url.ts`](src/lib/capture/clean-url.ts)): the part after `#`, sign-in and reset tokens, codes, keys, signatures, session ids and click trackers are cut (and on White Rabbit's own pages, who shared a link and which push or email it came from), and a link that is itself the way in to something private (a shared Google Doc, a Dropbox or OneDrive link, a meeting, an invite) isn't kept at all.
- It hands what it recorded only to White Rabbit's own tabs in the same browser (https://www.whiterabbt.com). The extension itself makes no network requests and loads no code from anywhere: there's no `fetch`, no analytics, and no `eval` in it. It hands nothing to a page that has ads in it: if Google's ad script, an ad slot or an ad frame appears in a White Rabbit tab, it stops answering that tab until it's reloaded.
- When you add it, your browser says it can "Read your browsing history" (open tabs and where you navigate). Your browser's own history is an optional permission. It's asked for only when you turn on Rabbit, in a small window of its own ([`extension/grant.html`](extension/grant.html)), and only if you press Allow there.

What White Rabbit does with your browsing once a White Rabbit tab has it is up to the web app, which isn't in this repository. In White Rabbit's words: Rabbit is off until you turn it on. If you do, once a day White Rabbit sends the page titles and search queries, site names, which page led to which, and time spent from browsing sittings you've finished, plus the titles of your rabbit holes that aren't private and of Rabbit's own earlier suggestions, to our AI provider, so Rabbit can suggest rabbit holes. Full addresses, the sites and categories you exclude, and incognito windows are never sent. The provider can't use it to train its models, and nothing is shared until you review it. To see exactly what Rabbit would send next, open **Settings → Capture & privacy → See exactly what Rabbit would send** on White Rabbit. The full [privacy policy](https://www.whiterabbt.com/help/privacy) covers the rest.

## White Rabbit Helper (Safari on a Mac)

Safari won't let a secure web page talk to an extension the way other browsers do, so on a Mac, Safari connects through White Rabbit Helper, a small menu bar app ([`helper/`](helper)). It reads Safari's history file (`~/Library/Safari/History.db`), which macOS allows only once you've given it Full Disk Access.

Unlike the extension, the Helper sends what it reads to your White Rabbit account: every five minutes, the address (without the part after `#`), title and time of each new visit. White Rabbit applies your rules, and cleans each address with the same `clean-url.ts`, before anything is kept, only you can see it, and it's deleted after seven days. Safari doesn't keep Private Browsing in its history, so that's never included.

When it pairs, the Helper shows you the account's email and connects only once you confirm it. It keeps its device token in your keychain, in an access group that only apps signed by White Rabbit's team can open, so no other program can read, replace or delete it. Its uninstall command disconnects the Mac from your account as it removes the Helper.

The download is signed with White Rabbit's Developer ID (team FSRF52G5UF) and notarized by Apple, and the install command checks three things before anything runs: the download's SHA-256, that signature, and Gatekeeper. A release build connects only to https://www.whiterabbt.com and reads only Safari's own history file, whatever its environment says. `DEBUG=1 helper/build.sh` makes a development build that doesn't have those limits. [`helper/SIGNING.md`](helper/SIGNING.md) covers how releases are signed, and what that does and doesn't protect.

## Build it, and compare it with the store

You need Node 22 or later and pnpm 11. Leave `WHITE_RABBIT_APP_URL`, `VERCEL_URL` and `VERCEL_PROJECT_PRODUCTION_URL` unset: each adds a site the extension would trust.

```bash
pnpm install --frozen-lockfile
pnpm build
```

This type-checks, bundles the scripts with esbuild, and writes `extension/dist/{chrome,firefox,safari}` and a zip of each. Building the same source always gives the same zips, byte for byte. The scripts, pages and icons in them are the files the stores serve. The stores add their own signature files, and the Chrome Web Store adds an `update_url` to `manifest.json`.

To compare with what you installed, open your browser's extensions page, find White Rabbit's folder on disk (Chrome shows its ID; the files are under your profile's `Extensions/<id>/<version>`), and compare:

```bash
diff -r extension/dist/chrome "<that folder>"
```

The Helper needs a Mac with Xcode, and its build isn't reproducible byte for byte (compiler and signature details differ between machines). To check the copy you installed instead:

```bash
codesign -dv ~/Applications/"White Rabbit Helper.app"         # TeamIdentifier=FSRF52G5UF
spctl --assess -vv ~/Applications/"White Rabbit Helper.app"   # source=Notarized Developer ID
```

If you'd rather not trust the download, `pnpm build:helper` makes a development build you can run. A release build needs White Rabbit's Developer ID, so yours is signed ad hoc on your Mac: it keeps its token in the older file-based keychain, where other programs can't read it but could replace it, and it can pair with any White Rabbit address.

## What's where

| Path | What it is |
| --- | --- |
| `extension/src/background.ts` | Records page views, applies every exclusion rule, reads the browser's history once allowed, and answers White Rabbit's tabs |
| `extension/src/bridge.ts` | Runs only on White Rabbit's own site; passes the page's requests to the background script and the answers back |
| `extension/src/popup.ts` | The toolbar popup: on or paused, a possible rabbit hole, and pause controls |
| `extension/src/grant.ts`, `extension/grant.html` | "Start with the past two days?", where the optional history permission is asked for |
| `extension/manifest.mjs` | Each browser's manifest, with every permission it asks for |
| `extension/origins.mjs` | The only sites the extension talks to |
| `extension/STORE.md` | What White Rabbit tells the Chrome Web Store and Firefox Add-ons, permission by permission. It names files from the app's repository, where it's kept. |
| `src/lib/capture/` | Detection, exclusion rules and address cleaning, shared with the web app |
| `helper/` | White Rabbit Helper for Safari on a Mac |

This repository is published from White Rabbit's app repository, where changes are made first.

## Security

Please report anything that could expose someone's browsing privately. See [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The White Rabbit name and logo aren't covered by the license.
