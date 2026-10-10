/**
 * Runs only on White Rabbit's own site. Relays the page's requests to the
 * background script and the answers back, over window messages:
 *
 *   page → { source: "white-rabbit-app", type: "hello" | "capture" | "ready" | "forget" | "lookBack", id? }
 *   here → { source: "white-rabbit-extension", type: "present" | "hello" | "capture" | "lookBack" | "review" | "error", id? }
 *
 * "present" is announced as soon as this script runs, so a White Rabbit tab
 * that was open when the extension was installed connects without a reload.
 * Only messages from this same window and origin are relayed.
 *
 * Nothing is handed to a page that has ads in it. White Rabbit never loads
 * Google's ad script in a tab where the extension is connected; if an ad
 * script, slot or frame shows up in this tab anyway, this stops relaying
 * anything but "hello" (which then says `ads: true`) for as long as the page
 * is open, so what the extension holds never reaches an ad platform.
 */

import { AD_MARKS as AD } from "../../src/lib/capture/ad-marks";
import { ext } from "./shared";

const APP = "white-rabbit-app";
const EXT = "white-rabbit-extension";

// Installing or updating the extension adds this script to tabs that already
// had a copy. The newest copy answers; older ones (whose extension context may
// be gone) stay quiet.
const self = {};
(window as unknown as { __whiteRabbitBridge?: object }).__whiteRabbitBridge = self;
const current = () =>
  (window as unknown as { __whiteRabbitBridge?: object }).__whiteRabbitBridge === self && !!ext.runtime?.id;

function post(message: Record<string, unknown>) {
  window.postMessage({ source: EXT, ...message }, window.location.origin);
}

let ads = false;
const hasAd = (node: Node) =>
  node instanceof Element && (node.matches(AD) || node.querySelector(AD) !== null);
// From document_start, before any of the page's scripts: once seen, for the rest of the page's life.
const watch = new MutationObserver((records) => {
  for (const r of records) {
    if ((r.type === "attributes" && hasAd(r.target)) || Array.from(r.addedNodes).some(hasAd)) {
      ads = true;
      watch.disconnect();
      return;
    }
  }
});
if (document.querySelector(AD)) ads = true;
else watch.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "id", "class"] });

async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const res = (await ext.runtime.sendMessage(message)) as T & { error?: string };
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(res.error);
  return res;
}

window.addEventListener("message", async (e: MessageEvent) => {
  if (e.source !== window || e.origin !== window.location.origin || !current()) return;
  const data = e.data as { source?: string; type?: string; id?: string; hours?: unknown; rules?: unknown } | null;
  if (!data || data.source !== APP) return;
  if (ads && data.type !== "hello") {
    if (data.id) post({ type: "error", id: data.id, message: "ads" });
    return;
  }

  try {
    if (data.type === "ready") {
      // The app is listening: hand over a rabbit hole picked in the popup, if any.
      const res = await ask<{ review?: unknown }>({ type: "pull" });
      if (res.review) post({ type: "review", payload: res.review });
    } else if (data.type === "hello") {
      const res = await ask<Record<string, unknown>>({ type: "hello" });
      post({ type: "hello", id: data.id, ...res, ...(ads ? { ads: true } : {}) });
    } else if (data.type === "forget") {
      await ask({ type: "forget" });
    } else if (data.type === "lookBack") {
      // Rabbit was just turned on: the extension asks, in its own window, for the browser's history.
      const res = await ask<Record<string, unknown>>({ type: "lookBack" });
      post({ type: "lookBack", id: data.id, ...res });
    } else if (data.type === "capture") {
      const hours = typeof data.hours === "number" && Number.isFinite(data.hours) ? data.hours : 24;
      const res = await ask<{ capture: unknown }>({ type: "capture", hours, rules: data.rules });
      post({ type: "capture", id: data.id, capture: res.capture });
    }
  } catch (err) {
    if (data.id && current()) {
      post({ type: "error", id: data.id, message: err instanceof Error ? err.message : String(err) });
    }
  }
});

post({ type: "present" });
