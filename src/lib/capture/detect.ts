/**
 * Rabbit-hole detection. Runs on the person's device only — in the browser
 * extension, and in the web app's demo device — and is shared verbatim by
 * both (the extension compiles this file; keep imports relative and free
 * of app code).
 *
 * Pipeline: drop anything excluded (blocked domains, sensitive categories,
 * sign-in and checkout pages, paused time) → split into sessions at long
 * gaps → link pages that belong together (tab openers, referrers, the same
 * tab, similar titles close in time) → leave out videos and feed pages that
 * share nothing with the rest (autoplay, recommendations) → keep clusters
 * that look like one line of curiosity, scored with an internal confidence.
 */

import { jaccard, keywords, normalize, phrases, tokens, tokenSet } from "../ai/text";
import { parseSearch } from "./search-engines";

export type Sensitive = "banking" | "medical" | "email" | "work" | "passwords" | "adult";

export interface DetectEvent {
  id: string;
  url: string;
  title: string;
  domain: string;
  at: string;
  tabId: number;
  openerTabId?: number;
  referrer?: string;
  transition: "link" | "typed" | "search" | "reload" | "back_forward";
  dwellSeconds: number;
}

export interface DetectRules {
  blockedDomains: string[];
  excluded: Sensitive[];
  /** Epoch ms, "indefinite", or null. Events during a pause are ignored. */
  pausedUntil?: number | "indefinite" | null;
  /** Events at or after this time were recorded while paused (set by the recorder). */
  pausedFrom?: number | null;
}

export interface Cluster {
  events: DetectEvent[];
  /** Pairs of event ids: [from, to] navigation links inside the cluster. */
  links: Array<[string, string]>;
  topic: string;
  confidence: number;
  minutes: number;
  domains: number;
}

export const SENSITIVE_PATTERNS: Record<Sensitive, RegExp[]> = {
  banking: [
    /bank/,
    /(^|\.)(chase|wellsfargo|citi|capitalone|americanexpress|schwab|fidelity|vanguard|paypal|venmo|wise|revolut|monzo|coinbase|robinhood|stripe)\.com$/,
    /(^|\.)(hsbc|barclays|santander|natwest|lloydsbank)\./,
  ],
  medical: [/mychart/, /patient/, /(^|\.)(webmd|zocdoc|mayoclinic|kp|kaiserpermanente|goodrx|healthline|cvs|walgreens|nhs)\./, /health|clinic|hospital|pharma/],
  email: [/^mail\./, /(^|\.)(gmail|outlook|hotmail|proton|fastmail|hey)\.(com|me)$/, /(^|\.)outlook\.live\.com$/],
  work: [/(^|\.)(slack|atlassian|salesforce|workday|zoom|zendesk|hubspot|monday|asana|linear|notion)\.(com|net|app|so|us)$/, /teams\.microsoft\.com$/, /(^|\.)sharepoint\.com$/, /^intranet\./],
  passwords: [/(^|\.)(1password|lastpass|bitwarden|dashlane|keepersecurity|nordpass)\.(com|eu)$/],
  adult: [/porn|xxx|onlyfans|adult/],
};

const PRIVATE_PATH = /\/(log-?in|sign-?in|sign-?up|auth|oauth|account|settings|checkout|cart|billing|password|reset)(\/|$|\?)/i;

export const SESSION_GAP_MS = 25 * 60_000;
export const MIN_PAGES = 5;
export const SUGGEST_AT = 0.6;

/** Sites where the next page is usually picked by autoplay or a feed, not by curiosity. */
const FEED_SITE = /(^|\.)(youtube\.com|youtu\.be|tiktok\.com|instagram\.com|facebook\.com|x\.com|twitter\.com|twitch\.tv)$/;
/** Words these sites put in every title, so they don't count as a shared subject. */
const FEED_WORDS = new Set(["tiktok", "instagram", "facebook", "twitter", "twitch", "video", "short", "reel", "watch", "live", "official", "full", "highlight"]);

function domainMatches(domain: string, blocked: string): boolean {
  const d = domain.toLowerCase();
  const b = blocked.toLowerCase().replace(/^\*\./, "").replace(/^www\./, "");
  return d === b || d.endsWith(`.${b}`);
}

/** Why an event is never analysed, or null when it may be. */
export function exclusionReason(e: DetectEvent, rules: DetectRules): string | null {
  if (!/^https?:\/\//i.test(e.url)) return "Not a web page";
  for (const b of rules.blockedDomains) if (domainMatches(e.domain, b)) return "Never analyze";
  for (const cat of rules.excluded) {
    if (SENSITIVE_PATTERNS[cat].some((re) => re.test(e.domain))) return cat;
  }
  try {
    if (PRIVATE_PATH.test(new URL(e.url).pathname)) return "Sign-in or checkout page";
  } catch {
    return "Not a web page";
  }
  const t = new Date(e.at).getTime();
  if (rules.pausedFrom != null && t >= rules.pausedFrom) {
    if (rules.pausedUntil === "indefinite") return "Paused";
    if (typeof rules.pausedUntil === "number" && t < rules.pausedUntil) return "Paused";
  }
  return null;
}

function sessions(events: DetectEvent[]): DetectEvent[][] {
  const out: DetectEvent[][] = [];
  let cur: DetectEvent[] = [];
  let last = -Infinity;
  for (const e of events) {
    const t = new Date(e.at).getTime();
    if (t - last > SESSION_GAP_MS && cur.length) {
      out.push(cur);
      cur = [];
    }
    cur.push(e);
    last = t + e.dwellSeconds * 1000;
  }
  if (cur.length) out.push(cur);
  return out;
}

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    const p = this.parent.get(x) ?? x;
    if (p === x) return x;
    const r = this.find(p);
    this.parent.set(x, r);
    return r;
  }
  union(a: string, b: string) {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(rb, ra);
  }
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

function prettyTopic(t: string): string {
  return t
    .split(" ")
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

/**
 * The words from the opening search that keep coming back:
 * "why is nuclear fusion so hard" → "nuclear fusion".
 */
function topicFromSearch(events: DetectEvent[]): string | null {
  const first = events.find((e) => parseSearch(e.url));
  if (!first) return null;
  const query = parseSearch(first.url)?.query ?? "";
  const others = events.filter((e) => e !== first).map((e) => tokenSet(e.title));
  const recurs = (stem: string) => others.filter((set) => set.has(stem)).length >= 2;
  const words = normalize(query).split(/[^a-z0-9]+/).filter(Boolean);
  let best: string[] = [];
  let run: string[] = [];
  const flush = () => {
    while (run.length && !recurs(tokens(run[run.length - 1])[0] ?? "")) run.pop();
    if (run.some((w) => recurs(tokens(w)[0] ?? "")) && run.length > best.length) best = run.slice(-3);
    run = [];
  };
  for (const w of words) {
    if (tokens(w).length === 0) flush();
    else run.push(w);
  }
  flush();
  return best.length ? best.join(" ") : null;
}

function topicOf(events: DetectEvent[]): string {
  const fromSearch = topicFromSearch(events);
  if (fromSearch) return prettyTopic(fromSearch);
  const titles = events.map((e) => e.title);
  const [phrase] = phrases(titles, 1, Math.max(2, Math.ceil(events.length * 0.25)));
  if (phrase) return prettyTopic(phrase);
  const [a, b] = keywords(titles, 2);
  return prettyTopic([a, b].filter(Boolean).join(" ") || events[0]?.domain || "Something new");
}

/**
 * Video and feed pages that share nothing with the rest of a rabbit hole
 * came from autoplay or a recommendation, not the curiosity itself: a
 * cooking video in the middle of a trail about fusion. Drops them and joins
 * the trail around them. The subject is the topic plus every other kind of
 * page, so a rabbit hole that's all videos still keeps the ones on topic.
 */
function dropFeedDetours(
  group: DetectEvent[],
  links: Array<[string, string]>,
  sets: Map<string, Set<string>>,
  topic: string,
): { group: DetectEvent[]; links: Array<[string, string]> } {
  const subject = new Set(tokens(topic));
  for (const e of group) if (!FEED_SITE.test(e.domain)) for (const w of sets.get(e.id)!) subject.add(w);
  const detours = new Set(
    group
      .filter((e) => FEED_SITE.test(e.domain) && e.transition !== "search")
      .filter((e) => ![...sets.get(e.id)!].some((w) => !FEED_WORDS.has(w) && subject.has(w)))
      .map((e) => e.id),
  );
  if (!detours.size) return { group, links };

  // What was reached from a detour is reached from whatever led to it.
  const from = new Map(links.map(([a, b]) => [b, a]));
  const keptFrom = (id: string): string | undefined => {
    let at: string | undefined = id;
    const seen = new Set<string>();
    while (at && detours.has(at) && !seen.has(at)) {
      seen.add(at);
      at = from.get(at);
    }
    return at && !detours.has(at) ? at : undefined;
  };
  const joined = new Map<string, [string, string]>();
  for (const [a, b] of links) {
    if (detours.has(b)) continue;
    const parent = keptFrom(a);
    if (parent && parent !== b) joined.set(`${parent}→${b}`, [parent, b]);
  }
  return { group: group.filter((e) => !detours.has(e.id)), links: [...joined.values()] };
}

const time = (e: DetectEvent) => new Date(e.at).getTime();

/**
 * Links between pages read in one sitting, in reading order: tab openers and
 * referrers, the same tab not long after, and clearly similar titles.
 */
export function linkPages(session: DetectEvent[]): Array<[string, string]> {
  const links: Array<[string, string]> = [];
  const sets = new Map(session.map((e) => [e.id, tokenSet(e.title)]));
  session.forEach((e, i) => {
    const earlier = session.slice(0, i);
    // Opened from another tab, or followed a link from a known page.
    const opener =
      (e.referrer && [...earlier].reverse().find((p) => p.url === e.referrer)) ||
      (e.openerTabId !== undefined && [...earlier].reverse().find((p) => p.tabId === e.openerTabId)) ||
      undefined;
    if (opener && time(e) - time(opener) < 15 * 60_000) {
      links.push([opener.id, e.id]);
      return;
    }
    // Same tab, not long after (people read), and at least loosely related.
    const prev = [...earlier].reverse().find((p) => p.tabId === e.tabId);
    if (prev && time(e) - (time(prev) + prev.dwellSeconds * 1000) < 12 * 60_000) {
      const sim = jaccard(sets.get(prev.id)!, sets.get(e.id)!);
      // Following a link within minutes is strong evidence on its own; typing a new address is not.
      const related = prev.transition === "search" || e.transition === "link" || sim >= 0.12;
      if (related) {
        links.push([prev.id, e.id]);
        return;
      }
    }
    // Otherwise, a clearly similar page not long before.
    let best: DetectEvent | undefined;
    let bestSim = 0.2;
    for (const p of earlier) {
      if (time(e) - time(p) > 20 * 60_000) continue;
      const sim = jaccard(sets.get(p.id)!, sets.get(e.id)!);
      if (sim > bestSim) {
        best = p;
        bestSim = sim;
      }
    }
    if (best) links.push([best.id, e.id]);
  });
  return links;
}

function spanMinutes(events: DetectEvent[]): number {
  const last = events[events.length - 1];
  return Math.max(1, Math.round((time(last) + last.dwellSeconds * 1000 - time(events[0])) / 60_000));
}

/**
 * A rabbit hole Rabbit found, as a cluster: its pages in reading order,
 * linked the same way detection links them. Rabbit chose the pages, so it's
 * certain; `topic` is Rabbit's title for it.
 */
export function clusterOf(pages: DetectEvent[], topic: string): Cluster {
  const events = [...pages].sort((a, b) => a.at.localeCompare(b.at));
  return {
    events,
    links: linkPages(events),
    topic,
    confidence: 1,
    minutes: spanMinutes(events),
    domains: new Set(events.map((e) => e.domain)).size,
  };
}

/** Groups allowed browsing into candidate rabbit holes. */
export function clusterBrowsingEvents(all: DetectEvent[], rules: DetectRules): Cluster[] {
  const events = all
    .filter((e) => exclusionReason(e, rules) === null)
    .sort((a, b) => a.at.localeCompare(b.at));

  const clusters: Cluster[] = [];
  for (const session of sessions(events)) {
    const uf = new UnionFind();
    const links = linkPages(session);
    for (const [a, b] of links) uf.union(a, b);
    const sets = new Map(session.map((e) => [e.id, tokenSet(e.title)]));

    const groups = new Map<string, DetectEvent[]>();
    for (const e of session) {
      const root = uf.find(e.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root)!.push(e);
    }

    for (const linked of groups.values()) {
      if (linked.length < MIN_PAGES) continue;
      const ids = new Set(linked.map((e) => e.id));
      const { group, links: groupLinks } = dropFeedDetours(
        linked,
        links.filter(([a, b]) => ids.has(a) && ids.has(b)),
        sets,
        topicOf(linked),
      );
      if (group.length < MIN_PAGES) continue;
      const minutes = spanMinutes(group);
      const domains = new Set(group.map((e) => e.domain)).size;
      const topic = topicOf(group);
      const topicSet = tokenSet(topic);
      const coherence =
        group.reduce((acc, e) => acc + (jaccard(sets.get(e.id)!, topicSet) > 0 ? 1 : 0), 0) / group.length;
      const linkRatio = groupLinks.length / Math.max(1, group.length - 1);
      const confidence = sigmoid(
        -4.2 +
          0.3 * Math.min(group.length, 15) +
          0.035 * Math.min(minutes, 60) +
          2.2 * coherence +
          0.25 * Math.min(domains, 6) +
          0.8 * linkRatio,
      );
      clusters.push({ events: group, links: groupLinks, topic, confidence, minutes, domains });
    }
  }
  // Most recent first: that's what the person is most likely to remember.
  return clusters.sort((a, b) => b.events[b.events.length - 1].at.localeCompare(a.events[a.events.length - 1].at));
}
