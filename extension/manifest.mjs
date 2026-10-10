// The manifest each build gets, for build.mjs. Kept apart so a test can
// check what the stores review (src/lib/server/extension-store.test.ts): no
// localhost in a store build, a use and a reason in extension/STORE.md for
// every permission, and no remote code.

/** Rendered from src/app/icon.svg; the stores require a 128px icon. */
const ICONS = Object.fromEntries([16, 32, 48, 128].map((s) => [String(s), `icons/icon-${s}.png`]));

/** What the stores show under the name. Chrome allows 132 characters. */
export const DESCRIPTION =
  "Notices when you go down a rabbit hole and shows it to you on White Rabbit, private until you choose to share it.";

/**
 * @param {"chrome" | "firefox" | "safari"} target
 * @param {readonly string[]} origins White Rabbit's sites (origins.mjs)
 * @param {string} version
 * @returns {Record<string, any>}
 */
export function manifest(target, origins, version) {
  const matches = origins.map((o) => `${o}/*`);
  /** @type {Record<string, any>} */
  const m = {
    manifest_version: 3,
    name: "White Rabbit",
    short_name: "White Rabbit",
    version,
    description: DESCRIPTION,
    incognito: "not_allowed",
    // `scripting` connects White Rabbit tabs that were already open when it was installed.
    permissions: ["storage", "tabs", "webNavigation", "alarms", "scripting"],
    // The browser's history is asked for only when the person turns on Rabbit
    // (grant.html), so adding the extension asks to "Read your browsing
    // history" instead of to read and change it on every signed-in device.
    // Safari has no history API; it reads what the extension records plus open tabs.
    ...(target === "safari" ? {} : { optional_permissions: ["history"] }),
    // Safari only reveals tab addresses for sites the extension may access.
    host_permissions: target === "safari" ? ["<all_urls>"] : matches,
    icons: ICONS,
    action: { default_title: "White Rabbit", default_popup: "popup.html", default_icon: ICONS },
    // document_start, so it's listening before the app first asks.
    content_scripts: [{ matches, js: ["js/bridge.js"], run_at: "document_start" }],
  };
  if (target === "firefox") {
    m.background = { scripts: ["js/background.js"] };
    m.browser_specific_settings = {
      gecko: {
        id: "white-rabbit@whiterabbit.app",
        // 128+ grants host access at install, so there's nothing to allow afterwards.
        strict_min_version: "128.0",
        // Page addresses and searches are handed to the open White Rabbit tab.
        data_collection_permissions: { required: ["browsingActivity", "searchTerms"] },
      },
    };
  } else {
    m.background = { service_worker: "js/background.js" };
    if (target === "chrome") m.minimum_chrome_version = "116";
  }
  return m;
}
