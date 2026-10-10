/**
 * White Rabbit's background script (a service worker in Chromium and Safari,
 * an event page in Firefox).
 *
 * It records page views in normal windows (never private ones), dropping
 * anything the person's rules exclude and cleaning every address of
 * fragments, tokens and other secret-looking parameters before it's stored
 * (src/lib/capture/clean-url.ts), and keeps a rolling week on this device.
 * Whenever a White Rabbit tab asks (it does so by itself when it opens or
 * comes back into view), it gathers the open tabs, the pages it recorded,
 * and — where the browser has a history API (Chromium, Firefox) and the
 * person allowed it — the browser's own history for the past week, runs
 * every exclusion rule, and hands the result to that tab. Nothing is sent
 * anywhere else.
 *
 * History is an optional permission, never asked for at install: White
 * Rabbit asks for it when the person turns on Rabbit (askForHistory, which
 * opens grant.html), so Rabbit's first look can start before the extension
 * was added.
 */

import { cleanPage, cleanUrl } from "../../src/lib/capture/clean-url";
import {
  clusterBrowsingEvents,
  exclusionReason,
  SENSITIVE_PATTERNS,
  SUGGEST_AT,
  type DetectEvent,
  type DetectRules,
  type Sensitive,
} from "../../src/lib/capture/detect";
import { parseSearch } from "../../src/lib/capture/search-engines";
import { browserName, buildSnapshot, domainOf, type CapturedTab } from "../../src/lib/capture/snapshot";
import {
  APP_ORIGIN,
  APP_ORIGINS,
  ext,
  isPaused,
  load,
  save,
  TARGET,
  VERSION,
  type ExtraRules,
  type Message,
  type RawCapture,
  type Settings,
  type SuggestionSummary,
} from "./shared";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_EVENTS = 3000;
const MAX_HISTORY_ITEMS = 600;

/** What the page asked to skip, kept to what's well formed: a category this build doesn't know is left out, not an error. */
function cleanExtra(extra: unknown): ExtraRules {
  const e = (extra && typeof extra === "object" ? extra : {}) as Record<string, unknown>;
  const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  return {
    blockedDomains: list(e.blockedDomains),
    excluded: list(e.excluded).filter((c): c is Sensitive => Object.hasOwn(SENSITIVE_PATTERNS, c)),
  };
}

function rules(s: Settings, extra?: ExtraRules): DetectRules {
  const more = cleanExtra(extra);
  return {
    blockedDomains: [...s.blockedDomains, ...more.blockedDomains!].slice(0, 2000),
    excluded: [...new Set([...s.excluded, ...more.excluded!])],
    pausedUntil: s.pausedUntil,
    pausedFrom: s.pausedFrom,
  };
}

/** Whether it may read the browser's own history: allowed in grant.html, and never in Safari, which has none. */
async function canReadHistory(): Promise<boolean> {
  if (TARGET === "safari") return false;
  try {
    return !!(await ext.permissions.contains({ permissions: ["history"] })) && !!ext.history?.search;
  } catch {
    return false;
  }
}

async function browserLabel(): Promise<string> {
  try {
    if (ext.runtime.getBrowserInfo) {
      const info = await ext.runtime.getBrowserInfo();
      return `${info.name} ${String(info.version).split(".")[0]}`;
    }
  } catch {
    /* fall through to the user agent */
  }
  const nav = navigator as Navigator & { userAgentData?: { brands: { brand: string; version: string }[] } };
  return browserName(nav.userAgent, nav.userAgentData?.brands);
}

/* ------------------------------------------------------------------ */
/* Recording                                                           */
/* ------------------------------------------------------------------ */

// The page currently open in each tab, so reading time can be filled in when
// the tab moves on. Kept in session storage too, because service workers sleep.
const openViews = new Map<number, { id: string; started: number }>();
const openers = new Map<number, number>();

async function restoreViews() {
  try {
    const saved = await ext.storage.session?.get("openViews");
    for (const [tab, view] of Object.entries(saved?.openViews ?? {}))
      openViews.set(Number(tab), view as { id: string; started: number });
  } catch {
    /* no session storage in this browser */
  }
}
const restored = restoreViews();

async function persistViews() {
  try {
    await ext.storage.session?.set({ openViews: Object.fromEntries(openViews) });
  } catch {
    /* no session storage in this browser */
  }
}

ext.tabs.onCreated.addListener((tab: { id?: number; openerTabId?: number }) => {
  if (tab.id !== undefined && tab.openerTabId !== undefined) openers.set(tab.id, tab.openerTabId);
});

async function closeView(tabId: number) {
  await restored;
  const open = openViews.get(tabId);
  if (!open) return;
  openViews.delete(tabId);
  void persistViews();
  const store = await load();
  const dwellSeconds = Math.min(86_400, Math.round((Date.now() - open.started) / 1000));
  await save({ events: store.events.map((e) => (e.id === open.id ? { ...e, dwellSeconds } : e)) });
}

ext.webNavigation.onCommitted.addListener(
  async (d: { tabId: number; frameId: number; url: string; transitionType: string; timeStamp: number }) => {
    if (d.frameId !== 0 || !/^https?:/.test(d.url)) return;
    const store = await load();
    const s = store.settings;
    if (!s.enabled || isPaused(s)) return;
    await closeView(d.tabId);

    const domain = domainOf(d.url);
    if (!domain) return;
    const tab = await ext.tabs.get(d.tabId).catch(() => null);
    if (tab?.incognito) return;

    // Only the cleaned address is ever written down, and a private link isn't at all.
    const event = cleanPage<DetectEvent>({
      id: `ev_${Math.round(d.timeStamp)}_${d.tabId}`,
      url: d.url,
      title: tab?.title || domain,
      domain,
      at: new Date(d.timeStamp).toISOString(),
      tabId: d.tabId,
      openerTabId: openers.get(d.tabId),
      transition: parseSearch(d.url)
        ? "search"
        : d.transitionType === "typed" || d.transitionType === "generated" || d.transitionType === "keyword"
          ? "typed"
          : d.transitionType === "reload"
            ? "reload"
            : "link",
      dwellSeconds: 0,
    });
    // Excluded pages are never written down, not even locally.
    if (!event || exclusionReason(event, rules(s)) !== null) return;

    const cutoff = Date.now() - WEEK_MS;
    const events = [...store.events.filter((e) => new Date(e.at).getTime() > cutoff), event].slice(-MAX_EVENTS);
    openViews.set(d.tabId, { id: event.id, started: Date.now() });
    void persistViews();
    await save({ events });
  },
);

// Titles arrive after the navigation commits.
ext.tabs.onUpdated.addListener(async (tabId: number, info: { title?: string }) => {
  if (!info.title) return;
  await restored;
  const open = openViews.get(tabId);
  if (!open) return;
  const store = await load();
  // A page without a title of its own is titled with its address: cleaned, like the address.
  const titled = (e: DetectEvent) => cleanPage({ ...e, title: info.title! }) ?? e;
  await save({ events: store.events.map((e) => (e.id === open.id ? titled(e) : e)) });
});

ext.tabs.onRemoved.addListener((tabId: number) => closeView(tabId));

/* ------------------------------------------------------------------ */
/* Detection (the popup's "possible rabbit hole")                      */
/* ------------------------------------------------------------------ */

async function detect() {
  const store = await load();
  if (!store.settings.enabled) return;
  const suggestions: SuggestionSummary[] = clusterBrowsingEvents(store.events, rules(store.settings))
    .filter((c) => c.confidence >= SUGGEST_AT)
    .map((c) => ({
      id: `sg_${c.events[0].id}`,
      topic: c.topic,
      pages: new Set(c.events.map((e) => e.url)).size,
      minutes: c.minutes,
      endedAt: c.events[c.events.length - 1].at,
    }))
    .filter((sg) => !store.decisions[sg.id]);
  await save({ suggestions });
  await ext.action.setBadgeText({ text: suggestions.length ? String(suggestions.length) : "" });
  await ext.action.setBadgeBackgroundColor({ color: "#5451d6" });
}

ext.alarms.create("detect", { periodInMinutes: 5 });
ext.alarms.onAlarm.addListener((a: { name: string }) => a.name === "detect" && detect());
ext.runtime.onStartup.addListener(detect);

/* ------------------------------------------------------------------ */
/* Install: connect White Rabbit tabs that are already open            */
/* ------------------------------------------------------------------ */

/**
 * Browsers only add content scripts to pages loaded after install, so the
 * White Rabbit tab the person installed from wouldn't see the extension until
 * reloaded. Add the bridge to those tabs now. Resolves to whether any were open.
 */
async function connectOpenTabs(): Promise<boolean> {
  const tabs: { id?: number }[] = await ext.tabs
    .query({ url: APP_ORIGINS.map((o) => `${o}/*`) })
    .catch(() => []);
  await Promise.all(
    tabs.map((tab) =>
      tab.id === undefined
        ? null
        : ext.scripting?.executeScript({ target: { tabId: tab.id }, files: ["js/bridge.js"] }).catch(() => null),
    ),
  );
  return tabs.length > 0;
}

ext.runtime.onInstalled.addListener(async (details: { reason: string }) => {
  if (details.reason === "update") {
    // Pages recorded by an earlier version kept whole addresses: clean them, and drop private links.
    const store = await load();
    await save({ events: store.events.flatMap((e) => cleanPage(e) ?? []) });
  }
  const connected = await connectOpenTabs();
  // Installed from a store page with no White Rabbit tab open: show where rabbit holes will appear.
  if (details.reason === "install" && !connected) await ext.tabs.create({ url: `${APP_ORIGIN}/` });
  await detect();
});

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

function transitionOf(t: string | undefined): DetectEvent["transition"] {
  if (t === "typed" || t === "generated" || t === "keyword" || t === "keyword_generated" || t === "auto_bookmark")
    return "typed";
  if (t === "reload") return "reload";
  return "link";
}

/** Visits from the browser's own history, once the person has allowed it. */
async function historyPages(since: number, recorded: DetectEvent[]): Promise<DetectEvent[]> {
  if (!(await canReadHistory())) return [];
  const items: { id: string; url?: string; title?: string; lastVisitTime?: number; typedCount?: number }[] =
    await ext.history.search({ text: "", startTime: since, maxResults: 5000 });
  // Each address as it's kept (the browser still looks its visits up by the whole one); private links aren't.
  const kept = new Map<string, string>();
  for (const it of items) {
    const url = it.url && /^https?:/.test(it.url) ? cleanUrl(it.url) : null;
    if (url) kept.set(it.url!, url);
  }
  const recent = items
    .filter((it) => it.url && kept.has(it.url))
    .sort((a, b) => (b.lastVisitTime ?? 0) - (a.lastVisitTime ?? 0))
    .slice(0, MAX_HISTORY_ITEMS);

  const visits = await Promise.all(
    recent.map(async (it) => {
      try {
        const vs: { visitId: string; visitTime?: number; referringVisitId?: string; transition?: string }[] =
          await ext.history.getVisits({ url: it.url });
        return { it, vs: vs.filter((v) => (v.visitTime ?? 0) >= since) };
      } catch {
        return { it, vs: [] };
      }
    }),
  );

  const urlOfVisit = new Map<string, string>();
  for (const { it, vs } of visits) for (const v of vs) urlOfVisit.set(v.visitId, kept.get(it.url!)!);

  // Pages this extension already recorded carry tabs and reading time; prefer those.
  const recordedAt = new Map<string, number[]>();
  for (const e of recorded) {
    const list = recordedAt.get(e.url) ?? [];
    list.push(new Date(e.at).getTime());
    recordedAt.set(e.url, list);
  }
  const alreadyRecorded = (url: string, t: number) => (recordedAt.get(url) ?? []).some((r) => Math.abs(r - t) < 5000);

  const out: DetectEvent[] = [];
  for (const { it, vs } of visits) {
    const url = kept.get(it.url!)!;
    const list = vs.length
      ? vs
      : [
          {
            visitId: `i${it.id}`,
            visitTime: it.lastVisitTime,
            transition: it.typedCount ? "typed" : "link",
            referringVisitId: undefined,
          },
        ];
    for (const v of list) {
      const t = v.visitTime ?? 0;
      if (t < since || alreadyRecorded(url, t)) continue;
      const referrer =
        v.referringVisitId && v.referringVisitId !== "0" && v.referringVisitId !== "-1"
          ? urlOfVisit.get(v.referringVisitId)
          : undefined;
      out.push({
        id: `hv_${v.visitId}`,
        url,
        title: it.title || domainOf(url),
        domain: domainOf(url),
        at: new Date(t).toISOString(),
        tabId: -1,
        referrer,
        transition: transitionOf(v.transition),
        dwellSeconds: 0,
      });
    }
  }
  return out;
}

async function gather(hours: number, extra?: ExtraRules): Promise<RawCapture> {
  const store = await load();
  const now = Date.now();
  const since = now - Math.min(Math.max(hours, 1), 24 * 7) * 3_600_000;

  const openTabs: {
    url?: string;
    title?: string;
    incognito?: boolean;
    active?: boolean;
    pinned?: boolean;
    windowId?: number;
    lastAccessed?: number;
  }[] = await ext.tabs.query({});
  const tabs: CapturedTab[] = openTabs
    .filter((t) => !t.incognito && t.url && /^https?:/.test(t.url))
    .map((t) => ({
      url: t.url!,
      title: t.title || domainOf(t.url!),
      domain: domainOf(t.url!),
      active: t.active,
      pinned: t.pinned,
      windowId: t.windowId,
      lastAccessed: t.lastAccessed ? new Date(t.lastAccessed).toISOString() : undefined,
    }));

  const recorded = store.events.filter((e) => new Date(e.at).getTime() >= since);
  const fromHistory = await historyPages(since, recorded).catch(() => []);

  // Every rule runs here, so excluded pages never leave the extension.
  const snapshot = buildSnapshot({
    source: "extension",
    browser: await browserLabel(),
    pages: [...recorded, ...fromHistory],
    tabs,
    rules: rules(store.settings, extra),
    from: new Date(since).toISOString(),
    to: new Date(now).toISOString(),
    now,
  });
  return {
    browser: snapshot.browser,
    from: snapshot.from,
    to: snapshot.to,
    pages: snapshot.pages,
    tabs: snapshot.tabs,
  };
}

/* ------------------------------------------------------------------ */
/* Asking for the browser's history                                    */
/* ------------------------------------------------------------------ */

const grantUrl = () => ext.runtime.getURL("grant.html");

/** The question, if it's open in some window. */
async function grantTab(): Promise<{ id?: number; windowId?: number } | undefined> {
  const tabs: { id?: number; windowId?: number; url?: string }[] = await ext.tabs.query({}).catch(() => []);
  return tabs.find((t) => t.url === grantUrl());
}

/**
 * Opens "Start with the past two days?" in a small window of its own, or
 * brings it to the front. Browsers ask for a permission only from a click on
 * the extension's own page, so White Rabbit's tab can't ask itself. Resolves
 * to whether it's showing.
 */
async function askForHistory(): Promise<boolean> {
  if (TARGET === "safari" || (await canReadHistory())) return false;
  const open = await grantTab();
  if (open?.windowId !== undefined) {
    await ext.windows.update(open.windowId, { focused: true }).catch(() => null);
    return true;
  }
  await ext.windows.create({ url: grantUrl(), type: "popup", width: 420, height: 440, focused: true });
  return true;
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

/** The popup: this extension, outside any tab (content scripts always come from one). */
function fromPopup(sender: { id?: string; tab?: unknown }): boolean {
  return sender.id === ext.runtime.id && !sender.tab;
}

function fromApp(sender: { id?: string; tab?: unknown; url?: string }): boolean {
  if (sender.id !== ext.runtime.id || !sender.tab || !sender.url) return false;
  try {
    return APP_ORIGINS.includes(new URL(sender.url).origin);
  } catch {
    return false;
  }
}

ext.runtime.onMessage.addListener(
  (msg: Message, sender: { id?: string; tab?: unknown; url?: string }, reply: (r: unknown) => void) => {
    (async () => {
      // The White Rabbit page may ask for these; nothing else may.
      if (
        (msg.type === "hello" ||
          msg.type === "capture" ||
          msg.type === "pull" ||
          msg.type === "forget" ||
          msg.type === "lookBack") &&
        !fromApp(sender)
      ) {
        return reply({ error: "not allowed" });
      }
      // And the popup's own controls, only from the popup.
      if (
        (msg.type === "status" ||
          msg.type === "pause" ||
          msg.type === "resume" ||
          msg.type === "ignore" ||
          msg.type === "review") &&
        !fromPopup(sender)
      ) {
        return reply({ error: "not allowed" });
      }
      const store = await load();
      switch (msg.type) {
        case "hello": {
          const history = await canReadHistory();
          return reply({
            version: VERSION,
            browser: await browserLabel(),
            history,
            // It can still ask, and whether its question is open now.
            askHistory: TARGET !== "safari" && !history,
            asking: !history && !!(await grantTab()),
          });
        }
        case "lookBack":
          // The person turned on Rabbit: ask whether its first look may start before the extension was added.
          return reply({ asking: await askForHistory() });
        case "capture":
          return reply({ capture: await gather(msg.hours, msg.rules) });
        case "pull": {
          await save({ pendingReview: null });
          return reply({ review: store.pendingReview });
        }
        case "forget":
          // The person deleted their history in White Rabbit: drop what was recorded here too.
          await save({ events: [], decisions: {}, suggestions: [], pendingReview: null });
          await ext.action.setBadgeText({ text: "" });
          return reply({ ok: true });
        case "status":
          return reply({ settings: store.settings, suggestions: store.suggestions });
        case "pause":
          await save({ settings: { ...store.settings, pausedUntil: msg.until, pausedFrom: Date.now() } });
          return reply({ ok: true });
        case "resume":
          await save({ settings: { ...store.settings, pausedUntil: null, pausedFrom: null } });
          return reply({ ok: true });
        case "ignore":
          await save({ decisions: { ...store.decisions, [msg.id]: "ignored" } });
          await detect();
          return reply({ ok: true });
        case "review": {
          const cluster = clusterBrowsingEvents(store.events, rules(store.settings)).find(
            (c) => `sg_${c.events[0].id}` === msg.id,
          );
          if (!cluster) return reply({ ok: false });
          // Only this rabbit hole's pages leave the extension, and only to the White Rabbit tab.
          await save({
            pendingReview: {
              topic: cluster.topic,
              minutes: cluster.minutes,
              pages: cluster.events.flatMap((e) => cleanPage(e) ?? []),
            },
            decisions: { ...store.decisions, [msg.id]: "reviewed" },
          });
          await ext.tabs.create({ url: `${APP_ORIGIN}/` });
          await detect();
          return reply({ ok: true });
        }
      }
    })().catch((err: unknown) => reply({ error: err instanceof Error ? err.message : String(err) }));
    return true; // async reply
  },
);
