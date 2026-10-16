# White Rabbit browser extension

Notices when you go down a rabbit hole (open tabs, searches, and the links between them) and shows it on White Rabbit. Adding it asks to "Read your browsing history" (tabs and navigation); the browser's own history is an optional permission it asks for only when the person turns on Rabbit (`grant.html`). There's nothing to press: whenever White Rabbit is open in this browser, it reads the past week from here by itself. What it reads goes only to White Rabbit tabs in this browser; the extension itself uploads nothing. If the person turns on Rabbit in White Rabbit, the app sends page titles and search queries, site names, which page led to which, and time spent, plus the titles of their rabbit holes that aren't private and of Rabbit's own earlier suggestions, to its AI provider once a day, never full addresses (see [Rabbit asks first](../README.md#rabbit-asks-first)), and tells White Rabbit how many rabbit holes Rabbit found and in which browser, never what they are.

One codebase, three builds:

| Build | Browsers | Background | History |
| --- | --- | --- | --- |
| `dist/chrome` | Chrome, Edge, Brave, Opera, Vivaldi, Arc | MV3 service worker | Recorded navigation, plus the browser's history for the past week once the person allows it |
| `dist/firefox` | Firefox 128+ (desktop) | MV3 event page | Same |
| `dist/safari` | Safari 16.4+ on Mac, iPhone, iPad | MV3 service worker | Navigation recorded since install. Safari has no history API. |

## Build

```bash
pnpm build:extension
```

It talks to https://www.whiterabbt.com, the Vercel deployment being built (`VERCEL_PROJECT_PRODUCTION_URL`, `VERCEL_URL`), and anything in `WHITE_RABBIT_APP_URL` (comma-separated). Store and deployment builds never trust localhost: any page on a local port, another project's dev server included, could ask them for a week of history. To use it with `pnpm dev`, build a development copy that also talks to localhost:3000 and :3100, and load that one unpacked:

```bash
pnpm build:extension --dev    # or WHITE_RABBIT_EXTENSION_DEV=1 pnpm build:extension
```

Don't upload a development build's zips to a store. What to upload, the checks to run first, and everything the store forms ask are in [STORE.md](STORE.md).

This type-checks, bundles each script with esbuild, writes a manifest per browser (`manifest.mjs`), and zips each build (`dist/white-rabbit-<browser>.zip`) for store upload. The Chromium and Firefox zips are also copied to `public/extension/`, which is what the site's **Add to Chrome** button hands out until the store listing exists. `pnpm build` runs this first, so every deployment serves an extension that matches it.

## Install

People add it from White Rabbit itself: **Add to Chrome** on Home or in Settings → Capture & privacy. With a store listing (`NEXT_PUBLIC_EXTENSION_CHROME_URL`, …) that's one click; see the main README for publishing. When it installs, it connects any White Rabbit tab that's already open, so capture starts without a reload.

By hand, for development:

- **Chromium browsers**: open `chrome://extensions` (or `edge://`, `brave://`, …), turn on **Developer mode**, and drag `extension/dist/chrome` onto the page (or **Load unpacked**). For the Chrome Web Store or Edge Add-ons, upload `white-rabbit-chrome.zip`.
- **Firefox**: open `about:debugging` → **This Firefox** → **Load Temporary Add-on**, and pick `white-rabbit-firefox.zip`. To publish, submit the same zip to addons.mozilla.org. The manifest declares its data collection (`browsingActivity`, `searchTerms`), as Firefox requires of new extensions.
- **Safari**: on a Mac with Xcode, run `xcrun safari-web-extension-converter extension/dist/safari --app-name "White Rabbit"`. Run the generated app once, then turn White Rabbit on in **Safari → Settings → Extensions** and allow it on all websites (Safari only shares tab addresses for sites an extension may access). Ship to iOS and macOS through the App Store.

Once it's in a store, set `NEXT_PUBLIC_EXTENSION_CHROME_URL`, `…_FIREFOX_URL`, or `…_SAFARI_URL` so **Add to …** goes there.

## How it works

| Piece | File | Does |
| --- | --- | --- |
| Background | `src/background.ts` | Records page views in normal windows (`"incognito": "not_allowed"`). Drops excluded pages before they're stored and keeps a rolling week in local storage. When a White Rabbit tab asks, gathers open tabs, recorded pages, and, once allowed, browser history (`history.search` + `getVisits`, which gives the link graph through `referringVisitId`; visits a Chromium browser marks `isLocal: false`, synced from the person's other devices, are skipped), and runs every rule. On install, adds the content script to White Rabbit tabs already open. Also runs detection every 5 minutes and shows a badge count. |
| Look back | `grant.html`, `src/grant.ts` | "Start with the past two days?" The background script opens it in a small window when a White Rabbit tab says Rabbit was just turned on (`lookBack`). **Allow** asks the browser for the optional `history` permission; browsers ask only from a click on the extension's own page. Its fine print says what Rabbit's first look is sent from the past two days (later looks carry on from where the last one stopped). The app holds Rabbit's first look until it's answered or closed. |
| Content script | `src/bridge.ts` | Runs only on the White Rabbit origins it was built for, from `document_start`. Announces itself (`present`), relays the page's `hello` / `capture` / `forget` requests to the background script, and hands over a rabbit hole picked in the popup. |
| Popup | `popup.html`, `src/popup.ts` | Whether it's on, **Open White Rabbit**, the current possible rabbit hole with **Review** and **Ignore**, pause controls, and settings. |
| Shared code | `../src/lib/capture/{snapshot,detect,search-engines,clean-url}.ts` | The same capture, detection and address-cleaning code the web app uses. On White Rabbit's own pages, `clean-url.ts` also cuts who shared a link and which push or email it came from (`from`, `src`, `k`). |

The background script answers `hello`, `capture`, `pull`, `forget`, and `lookBack` only from White Rabbit pages, and the popup's own messages only from the popup. The app validates everything it receives and applies the person's rules again.

Anything running in a White Rabbit page can ask for the same things the page can, including other extensions you've allowed on www.whiterabbt.com, which could read the page itself anyway. White Rabbit never loads Google's ad script in a tab where the extension is connected, and if an ad script, ad slot or ad frame shows up in a tab anyway, the content script stops passing anything but `hello` for as long as that page is open (`hello` then says `ads: true`).

## Privacy rules enforced here

- Never runs in private or incognito windows.
- Pages on the never-analyze list, in sensitive categories (banking, medical, email, work tools, password managers, adult), or on sign-in/checkout paths are discarded, not stored. The app's own list is applied too, when it asks for a capture.
- Every address is cleaned before it's stored: fragments, sign-in tokens and other secrets, click trackers, and, on White Rabbit's own pages, who shared the link and which push or email it came from.
- Pausing stops recording immediately. Nothing observed while paused is kept.
- History older than a week is deleted automatically.
- **Delete history** in White Rabbit clears what it recorded here too.
- No analytics and no remote calls. The only outbound action is handing pages or a reviewed rabbit hole to a White Rabbit tab in the same browser.
