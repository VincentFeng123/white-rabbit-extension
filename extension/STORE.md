# White Rabbit in the browser stores

Everything to paste into the Chrome Web Store and Firefox Add-ons forms. Submitting needs your own developer accounts: the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) (a one-time $5 fee; Edge, Brave, Opera, Vivaldi, and Arc install from it too) and [Firefox Add-ons](https://addons.mozilla.org/developers/).

`src/lib/server/extension-store.test.ts` keeps this file honest: it fails if a build asks for a permission with no reason here, if the short description isn't the manifest's, or if the privacy answer stops matching Rabbit's disclosure (`src/lib/capture/disclosure.ts`).

## Build what you upload

Build the store zips on your own computer, not on Vercel: a deployment's build also trusts that deployment's own address.

```bash
env -u VERCEL_URL -u VERCEL_PROJECT_PRODUCTION_URL -u WHITE_RABBIT_APP_URL -u WHITE_RABBIT_EXTENSION_DEV pnpm build:extension
```

It should say `for https://www.whiterabbt.com` and nothing about a development build. Then check what a reviewer checks:

```bash
# Only White Rabbit's site, and only the permissions below.
node -e 'for (const t of ["chrome", "firefox"]) { const m = require(`./extension/dist/${t}/manifest.json`); console.log(t, JSON.stringify(m.permissions), JSON.stringify(m.optional_permissions), JSON.stringify(m.host_permissions), JSON.stringify(m.content_scripts[0].matches), m.content_security_policy ?? "default CSP"); }'
# No localhost, and nothing that loads or runs code from elsewhere. Prints "clean".
grep -rEn 'localhost|127\.0\.0\.1|eval\(|new Function|importScripts\(|import\(|fetch\(|XMLHttpRequest|WebSocket' extension/dist/chrome extension/dist/firefox || echo clean
```

The first prints, for both, `["storage","tabs","webNavigation","alarms","scripting"]`, `["history"]`, `["https://www.whiterabbt.com/*"]` twice, and `default CSP`.

The zips are the same byte for byte every time they're built from the same source (each entry has a fixed date), so anyone can build the published source and compare it with what's in the store:

```bash
shasum -a 256 extension/dist/white-rabbit-chrome.zip extension/dist/white-rabbit-firefox.zip
```

Upload `extension/dist/white-rabbit-chrome.zip` to the Chrome Web Store (and Edge Add-ons, if you list it there) and `extension/dist/white-rabbit-firefox.zip` to Firefox Add-ons. Firefox also asks for the source, since the scripts are bundled:

```bash
git archive --format=zip -o extension/dist/white-rabbit-source.zip HEAD extension src/lib/capture/detect.ts src/lib/capture/snapshot.ts src/lib/capture/search-engines.ts src/lib/ai/text.ts package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json
```

Built from it, the scripts match the ones you upload byte for byte. The root `tsconfig.json` is there because it decides how the shared code compiles.

## Listing

**Name:** White Rabbit

**Short description** (Chrome's summary and Firefox's, from the manifest):

Notices when you go down a rabbit hole and shows it to you on White Rabbit, private until you choose to share it.

**Category:** Social Networking (Chrome), Social & Communication (Firefox)

**Language:** English

**Homepage:** https://www.whiterabbt.com

**Privacy policy:** https://www.whiterabbt.com/help/privacy

**Detailed description:**

> White Rabbit is a social network for curiosity: the paths people take from one question to the next.
>
> This extension notices when you go down a rabbit hole, a run of searches and pages that lead from one to the next, and shows it to you on White Rabbit. There's nothing to press. Whenever White Rabbit is open in this browser, it reads the past week from here by itself.
>
> • Private until you choose. Every rabbit hole it notices waits for you. Share it, keep it private, or ignore it.
> • Never in incognito or private windows.
> • Skips what you'd rather keep to yourself: banking, health, email, work tools, password managers, adult sites, sign-in and checkout pages, and any site you add to your Never analyze list.
> • Pause it any time, or delete everything it recorded from White Rabbit's settings.
> • Works in Chrome, Edge, Brave, Opera, Vivaldi, Arc, and Firefox.
> • Open source: read exactly what it does at https://github.com/VincentFeng123/white-rabbit-extension
>
> What it reads goes only to White Rabbit tabs in this browser. Rabbit is off until you turn it on. If you do, once a day White Rabbit sends the page titles and search queries, site names, which page led to which, and time spent from browsing sittings you've finished, plus the titles of your rabbit holes that aren't private and of Rabbit's own earlier suggestions, to our AI provider, so Rabbit can suggest rabbit holes. Full addresses, the sites and categories you exclude, and incognito windows are never sent. The provider can't use it to train its models, and nothing is shared until you review it.

## Single purpose

White Rabbit notices rabbit holes in your browsing (the searches and pages that led from one to the next) and shows them to you on White Rabbit, where nothing is shared until you review it.

## Permissions

### `history`

Optional, and never asked for when the extension is added. When you turn on Rabbit in White Rabbit, the extension opens a small window of its own, "Start with the past two days?", and asks for it only if you press Allow there. With it, the extension reads the past week of your browser history, and which visit led to which, so a rabbit hole you went down before installing the extension can still be noticed. Only pages that pass your rules are kept, and only for a week. Without it, the extension notices what you browse from when it was added. (Not in the Safari build, which has no history API.)

### `tabs`

Reads the address and title of your open tabs, and which tab opened which, so the pages you have open now count and each page keeps its title. It also tells a private window apart, so nothing there is recorded.

### `webNavigation`

Notices each page you open in a normal window, and whether you got there from a link, a search, or by typing, so it can tell which page led to which.

### `scripting`

When the extension is installed, connects White Rabbit tabs that are already open (only https://www.whiterabbt.com), so capture starts without a reload. It runs nothing on any other site.

### `storage`

Keeps your capture rules and a rolling week of the pages it noticed, on this device.

### `alarms`

Looks over what it noticed every 5 minutes for a possible rabbit hole, to show a count on the toolbar button.

### Host permission: `https://www.whiterabbt.com/*`

The only site the extension talks to. Its content script runs there, so White Rabbit's own tabs can ask for what it noticed. It reads nothing from the pages you visit.

## Remote code

No. Every script is in the package, bundled when it's built. It loads nothing from the network, uses no `eval`, and keeps the browser's default content security policy.

## Privacy practices

**Chrome Web Store → Privacy → Data usage.** Check one box:

- **Web history.** The pages you visit, with their titles and times, and which led to which.

Leave every other box unchecked: personally identifiable information, health, financial and payment, authentication, personal communications, location, user activity, and website content. The extension never reads what's on a page.

Check all three certifications: not sold to third parties, not used for purposes unrelated to the single purpose, and not used to decide creditworthiness or for lending.

**What happens to it** (paste where the form asks how data is used, and in Firefox's notes for reviewers):

> What the extension reads goes only to White Rabbit tabs in this browser. Rabbit is off until you turn it on. If you do, once a day White Rabbit sends the page titles and search queries, site names, which page led to which, and time spent from browsing sittings you've finished, plus the titles of your rabbit holes that aren't private and of Rabbit's own earlier suggestions, to our AI provider, so Rabbit can suggest rabbit holes. Full addresses, the sites and categories you exclude, and incognito windows are never sent. The provider can't use it to train its models, and nothing is shared until you review it.

**Firefox Add-ons.** The manifest declares its data collection (`browsingActivity`, `searchTerms`, both required), which Firefox shows when it's added. Give the privacy policy link above.

**Notes for reviewers:**

> The extension talks only to https://www.whiterabbt.com. To see it work: install it, open https://www.whiterabbt.com and sign up, then visit a few pages that lead from one to the next, for example a search and two results. The toolbar popup shows the possible rabbit hole it noticed. The optional `history` permission is requested from grant.html, a small window the extension opens when you answer "Turn on Rabbit" on White Rabbit, and only when you press Allow there. Settings → Capture & privacy on White Rabbit shows that the extension is connected. Firefox's source: white-rabbit-source.zip. Build it with Node 22 or later and pnpm 11 (`pnpm install --frozen-lockfile`, then `pnpm build:extension` with no environment variables set); the result is extension/dist/firefox.

## Screenshots

1280×800 PNGs, at most 5 (Chrome). Firefox takes the same ones. Take them on www.whiterabbt.com with a test account, never your own browsing:

1. Home with "Looks like you went down a rabbit hole": the card, its sites and minutes, and **Review & share**, **Save privately**, **Ignore**.
2. The composer opened from that card: the Trail it put together, with visibility set to private.
3. "Let Rabbit find your rabbit holes?": the question and what's sent, never sent, and to whom.
4. Settings → Capture & privacy: the extension connected, the Never analyze list, and the skipped categories.
5. The toolbar popup: on, the current possible rabbit hole with **Review** and **Ignore**, and pause.

Chrome also asks for a 440×280 small promo tile: the White Rabbit logo on white, with "Notice your rabbit holes".

## After approval

Set `NEXT_PUBLIC_EXTENSION_CHROME_URL` (and `NEXT_PUBLIC_EXTENSION_FIREFOX_URL`) in Vercel to the store pages and redeploy. **Add to Chrome** then opens the store page, one click to add.
