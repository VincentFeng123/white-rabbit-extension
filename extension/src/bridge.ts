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
 */

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

async function ask<T>(message: Record<string, unknown>): Promise<T> {
  const res = (await ext.runtime.sendMessage(message)) as T & { error?: string };
  if (res && typeof res === "object" && "error" in res && res.error) throw new Error(res.error);
  return res;
}

window.addEventListener("message", async (e: MessageEvent) => {
  if (e.source !== window || e.origin !== window.location.origin || !current()) return;
  const data = e.data as { source?: string; type?: string; id?: string; hours?: unknown; rules?: unknown } | null;
  if (!data || data.source !== APP) return;

  try {
    if (data.type === "ready") {
      // The app is listening: hand over a rabbit hole picked in the popup, if any.
      const res = await ask<{ review?: unknown }>({ type: "pull" });
      if (res.review) post({ type: "review", payload: res.review });
    } else if (data.type === "hello") {
      const res = await ask<Record<string, unknown>>({ type: "hello" });
      post({ type: "hello", id: data.id, ...res });
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
