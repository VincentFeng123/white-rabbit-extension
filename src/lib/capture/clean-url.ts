/**
 * What's kept of a page's address. Capture keeps the address of every page
 * it keeps, and a trail made from them may be published, so each address is
 * cut down to what says which page it was before anything is stored:
 *
 *  - no fragment (#…), and no name or password before the host;
 *  - no query parameter that looks like a secret: named like one (token,
 *    code, key, sig, session, password, otp, reset, invite, magic, …) or
 *    holding one (a JWT, an email address, a long random string), and none
 *    that only tracks a click (utm_*, fbclid, …). An address carried in a
 *    parameter (?next=, ?url=) is cleaned the same way;
 *  - a search keeps its query and nothing else (./search-engines), and a few
 *    sites keep just the parameters that say which page it was (YouTube's
 *    v and list);
 *  - a link that is itself the way in to something private isn't kept at
 *    all: a shared Google Doc, Dropbox or OneDrive link, a meeting, an
 *    invite, a magic or reset link. Its path is the key, so no cleaner form
 *    of it is safe, and its title usually names the private thing.
 *
 * An address with nothing to remove comes back exactly as it was.
 *
 * Shared verbatim by the web app, the server, and the browser extension (the
 * extension compiles this file), so keep imports relative and app-free.
 */

import { searchQueryParams } from "./search-engines";

/** Links that let whoever holds them in: host, and the paths on it that do (every path when there's none). */
const PRIVATE_LINKS: Array<[host: RegExp, path?: RegExp]> = [
  [/^(docs|drive|drive\.usercontent|photos|meet|calendar|lookerstudio|datastudio)\.google\.com$/],
  [/^colab\.research\.google\.com$/, /^\/drive\//],
  [/^(photos\.app\.goo\.gl|forms\.gle)$/],
  [/(^|\.)dropbox\.com$/, /^\/(s|sh|scl|t|l|request|transfer|preview)\//],
  [/^(dl\.dropboxusercontent|paper\.dropbox)\.com$/],
  [/^(1drv\.ms|onedrive\.live\.com|app\.box\.com|share\.icloud\.com|we\.tl|drive\.proton\.me)$/],
  [/(^|\.)sharepoint\.com$/],
  [/(^|\.)box\.com$/, /^\/(s|v|shared)\//],
  [/^icloud\.com$/, /^\/./],
  [/(^|\.)wetransfer\.com$/, /^\/downloads\//],
  [/(^|\.)zoom\.us$/, /^\/(j|w|s|wc|my|rec|webinar|ejl)\//],
  [/^teams\.microsoft\.com$/, /^\/(l|meet)\//],
  [/^teams\.live\.com$/, /^\/meet\//],
  [/(^|\.)webex\.com$/, /^\/(meet|join)\/|\/j\.php$/],
  [/^(meet\.jit\.si|8x8\.vc|meet\.goto\.com|app\.chime\.aws)$/, /^\/./],
  [/(^|\.)gotomeeting\.com$/, /^\/join\//],
  // Rooms are a single name at the top; Whereby's own pages are under /information/.
  [/(^|\.)whereby\.com$/, /^\/(?!information\/)[^/]+\/?$/],
  [/(^|\.)calendly\.com$/, /^\/(reschedulings|cancellations|invitees)\//],
  [/(^|\.)figma\.com$/, /^\/(file|design|board|proto|slides|deck|make)\//],
  [/(^|\.)canva\.com$/, /^\/design\//],
  [/(^|\.)miro\.com$/, /^\/app\//],
  [/(^|\.)loom\.com$/, /^\/(share|embed)\//],
  [/(^|\.)airtable\.com$/, /^\/(shr|app)[A-Za-z0-9]/],
  [/(^|\.)overleaf\.com$/, /^\/(read|project)\//],
  [/^(discord\.gg|chat\.whatsapp\.com|wa\.me|signal\.group|signal\.me|join\.slack\.com)$/],
  [/^(api|web)\.whatsapp\.com$/, /^\/send/],
  [/^(t|telegram)\.me$/, /^\/(\+|joinchat\/)/],
  [/^mega\.nz$/, /^\/(file|folder)\//],
  [/(^|\.)docusign\.(net|com)$/, /^\/(signing|member)\//i],
];

/**
 * A key in the path, on any site: /invite/<code>, /magic-link/<token>,
 * /reset-password/<token>, /password_reset/<token>, /verify-email/<token>,
 * /accept-invite/<code>. The word is lowercase and what follows is shaped
 * like a key (a JWT, or 6 or more characters with a digit or a capital in
 * them and no file extension, maybe after a numeric id), so a page about any
 * of these (/wiki/Activation, /r/magic) and a code or docs folder with one of
 * these names (/cli/verify/verify.go, /docs/verify/api, /packages/confirm/src)
 * stay.
 */
const KEY_SEGMENT =
  /\/(?:accept[-_]?)?(?:invites?|invitations?|magic[-_]?link|reset[-_]?password|password[-_/]?reset|(?:email[-_]?)?(?:verify|verification|confirm|confirmation|activate|activation)(?:[-_]?(?:email|account))?|unsubscribe)\/(?:\d+\/)?(?:eyJ[\w-]*\.[\w.-]+|(?=[^/.]*[\dA-Z])[^/.]{6,})(?:\/|$)/;

/** Session ids some servers write into the path: /item;jsessionid=… */
const PATH_SESSION = /;(jsessionid|phpsessid|sessionid|sid)=[^/;]*/gi;

/** Sites whose pages are told apart by a few parameters: those are kept, and nothing else. */
const SITE_PARAMS: Array<[host: RegExp, keep: string[]]> = [
  [/^(m\.|music\.)?youtube\.com$/, ["v", "list", "index", "t", "start"]],
  [/^youtu\.be$/, ["list", "t"]],
];

/**
 * Parameters whose long ids name a public page, not a key: a commit on a git
 * web view (linux.git/commit/?id=<sha>, /git/?p=gcc.git;a=commit;h=<sha>), a
 * Rust Playground gist, a Google Maps place, a Facebook post. Host, names, and
 * what the path and query must show (anything when there's none).
 */
const PUBLIC_IDS: Array<[host: RegExp, names: string[], where?: RegExp]> = [
  [/./, ["id", "id2", "h", "hb", "hp", "p"], /\.git([/;]|$)/],
  [/^play\.rust-lang\.org$/, ["gist"]],
  [/(^|\.)google\.[a-z.]+$/, ["q", "query_place_id"], /^\/maps\//],
  [/(^|\.)facebook\.com$/, ["story_fbid", "fbid"]],
];

function publicId(u: URL, name: string): boolean {
  const host = hostOf(u);
  return PUBLIC_IDS.some(
    ([h, names, where]) => h.test(host) && names.includes(name) && (!where || where.test(u.pathname + u.search)),
  );
}

/** Parameters a site adds to say who shared a link. */
const SITE_SHARER: Array<[host: RegExp, drop: string[]]> = [[/^(mobile\.)?(x|twitter)\.com$/, ["s", "t"]]];

/** Parameters that only track a click or a share. */
const TRACKING =
  /^(utm_\w+|fbclid|gclid|gclsrc|dclid|gbraid|wbraid|msclkid|yclid|twclid|ttclid|li_fat_id|igshid|igsh|mc_cid|mc_eid|_hsenc|_hsmi|mkt_tok|oly_anon_id|oly_enc_id|vero_id|wickedid|_ga|_gl|si|ref_src|ref_url|spm|trk)$/i;

/** Words in a parameter's name that mark it as a secret: access_token → access, token. */
const SECRET_WORDS = new Set([
  "token",
  "tok",
  "code",
  "key",
  "rlkey",
  "sk",
  "sig",
  "sign",
  "signature",
  "signed",
  "hmac",
  "hash",
  "auth",
  "authuser",
  "authorization",
  "session",
  "sess",
  "sid",
  "pwd",
  "pw",
  "pass",
  "passwd",
  "password",
  "passcode",
  "pin",
  "otp",
  "totp",
  "mfa",
  "reset",
  "invite",
  "invitation",
  "magic",
  "secret",
  "credential",
  "credentials",
  "nonce",
  "ticket",
  "saml",
  "jwt",
  "bearer",
  "verify",
  "verification",
  "confirm",
  "confirmation",
  "activation",
  "csrf",
  "xsrf",
  "email",
]);

/** The same, run together with other words: PHPSESSID, sessionid, apikey. */
const SECRET_STEM =
  /token|secret|passw|pwd|sessid|session|signature|apikey|accesskey|credential|csrf|xsrf|jwt|samlre|relaystate|(access|auth|invite|reset|share|verify|confirm|login|signin)(code|key)|oauthverifier/;

// Bounded, so each is quick however long the value (an address is at most 64 + 255 characters).
const JWT = /eyJ[\w-]{6,2000}\.[\w-]{6,2000}\./;
const EMAIL = /[\w.+-]{1,64}@[\w-]{1,63}(\.[\w-]{1,63}){0,8}\.[a-z]{2,24}/i;

/**
 * Longer than this, a parameter's value or name is a blob or a key, not part
 * of saying which page it was, and it's dropped before any check reads it.
 */
const MAX_VALUE = 2048;
const MAX_NAME = 256;

/** How deep an address inside an address inside an address is followed. */
const MAX_DEPTH = 3;

function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])(?=[A-Z][a-z])/g, "$1 ")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function secretName(name: string): boolean {
  return (
    words(name).some((w) => SECRET_WORDS.has(w)) || SECRET_STEM.test(name.toLowerCase().replace(/[^a-z0-9]/g, ""))
  );
}

/** A stretch of 20 or more letters and digits, mixed: a key, a hash, an id that works as a password. */
function randomish(value: string): boolean {
  return value.split(/[^A-Za-z0-9]+/).some((s) => s.length >= 20 && /[A-Za-z]/.test(s) && /\d/.test(s));
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function hostOf(u: URL): string {
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

/** Whether an address is itself the way in to something private, so nothing of it is kept. */
export function isPrivateLink(u: URL): boolean {
  const host = hostOf(u);
  if (KEY_SEGMENT.test(u.pathname)) return true;
  return PRIVATE_LINKS.some(([h, path]) => h.test(host) && (!path || path.test(u.pathname)));
}

/**
 * Which of a page's parameters are kept: given its name and raw value, true
 * to keep it as it is, false to drop it, or a cleaned raw value.
 */
function paramRule(u: URL, depth: number): (name: string, rawValue: string) => boolean | string {
  const host = hostOf(u);
  const only = searchQueryParams(u) ?? SITE_PARAMS.find(([h]) => h.test(host))?.[1];
  if (only) return (name) => only.includes(name.toLowerCase());
  const sharer = SITE_SHARER.find(([h]) => h.test(host))?.[1] ?? [];
  return (name, rawValue) => keepParam(u, name, rawValue, depth, sharer);
}

function keepParam(u: URL, name: string, rawValue: string, depth: number, sharer: string[]): boolean | string {
  if (name.length > MAX_NAME || rawValue.length > MAX_VALUE) return false;
  const lower = name.toLowerCase();
  if (sharer.includes(lower) || TRACKING.test(lower) || secretName(name)) return false;

  const value = decode(rawValue);
  const relative = value.startsWith("/") && !value.startsWith("//");
  if (relative || /^https?:\/\//i.test(value)) {
    if (depth >= MAX_DEPTH) return false;
    let inner = value;
    if (relative) {
      // "/\…" reads as a host-relative address with a bad host: not an address to keep.
      try {
        inner = new URL(value, u.origin).href;
      } catch {
        return false;
      }
    }
    const cleaned = clean(inner, depth + 1);
    if (cleaned === null) return false;
    if (cleaned === inner) return true;
    return encodeURIComponent(relative && cleaned.startsWith(u.origin) ? cleaned.slice(u.origin.length) : cleaned);
  }
  return !(
    (value.includes("eyJ") && JWT.test(value)) ||
    (value.includes("@") && EMAIL.test(value)) ||
    (randomish(value) && !publicId(u, lower))
  );
}

function clean(url: string, depth: number): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (isPrivateLink(u)) return null;

  let changed = url.includes("#") || u.username !== "" || u.password !== "";
  const path = u.pathname.replace(PATH_SESSION, "");
  if (path !== u.pathname) changed = true;

  const kept: string[] = [];
  const rule = u.search ? paramRule(u, depth) : null;
  for (const part of u.search.slice(1).split("&")) {
    if (!part || !rule) continue;
    const eq = part.indexOf("=");
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const keep = rule(decode(rawName.replace(/\+/g, " ")).trim(), eq < 0 ? "" : part.slice(eq + 1));
    if (keep === true) kept.push(part);
    else if (keep !== false) kept.push(`${rawName}=${keep}`);
    if (keep !== true) changed = true;
  }
  if (!changed) return url;
  return `${u.protocol}//${u.host}${path}${kept.length ? `?${kept.join("&")}` : ""}`;
}

/** The address as it's kept, or null when the page isn't kept at all (a private link, or not a web page). */
export function cleanUrl(url: string): string | null {
  return clean(url, 0);
}

/** A title that's only the page's address (what browsers show for a page without one), cleaned like it. */
function cleanAddressTitle(title: string, url: string): string {
  const scheme = /^https?:\/\//i.exec(title.trim())?.[0];
  const bare = title.trim().slice(scheme?.length ?? 0);
  // Browsers show %20 as a space and a punycode host in Unicode, so only the host
  // has to be free of spaces, and it's compared as the address parser reads it.
  const lead = bare.split(/[/?#]/, 1)[0];
  if (!lead || /[\s@]/.test(lead)) return title;
  let host: string;
  try {
    const u = new URL(url);
    host = u.host.toLowerCase().replace(/^www\./, "");
    if (new URL(`${u.protocol}//${lead}`).host.replace(/^www\./, "") !== host) return title;
    // With a space in it, it's the address only if it reads back as exactly this page's
    // address: "example.com/blog #1 post" is a title that happens to start with the site.
    if (/\s/.test(bare) && new URL(`${scheme ?? `${u.protocol}//`}${bare}`).href !== u.href) return title;
  } catch {
    return title;
  }
  const cleaned = cleanUrl(`${scheme ?? "https://"}${bare}`);
  if (cleaned === null) return host;
  return scheme ? cleaned : cleaned.replace(/^https?:\/\//i, "");
}

/**
 * A page as it's kept: its address cleaned, the page it came from cleaned
 * (or forgotten, when that was a private link), and a title that's only the
 * address cleaned too. Null when the page itself isn't kept.
 */
export function cleanPage<T extends { url: string; title?: string; referrer?: string }>(page: T): T | null {
  const url = cleanUrl(page.url);
  if (url === null) return null;
  const out: T = { ...page, url };
  if (page.title) out.title = cleanAddressTitle(page.title, page.url);
  if (page.referrer !== undefined) {
    const referrer = cleanUrl(page.referrer);
    if (referrer === null) delete out.referrer;
    else out.referrer = referrer;
  }
  return out;
}
