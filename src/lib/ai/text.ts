/**
 * Small, dependency-free text tools for the on-device engine: tokenising,
 * keyword extraction, similarity, and sentence helpers. Deterministic, so
 * the same input always produces the same output.
 */

const STOP = new Set(
  (
    "a about above after again against all almost also am an and any are aren't as at be because been before being " +
    "below between both but by can can't cannot could did didn't do does doesn't doing don't down during each even ever " +
    "every few for from further get got had has have having he her here hers him his how i if in into is isn't it it's " +
    "its itself just like made make makes many may me might more most much must my no nor not now of off often on once " +
    "one only or other our out over own really same she should so some such than that that's the their them then there " +
    "these they thing things this those through to too under until up upon us very was wasn't way we well were what " +
    "what's when where which while who whom why will with without would you your yours actually still yet ever lot " +
    "new first last next old another want wanted went going ended started turns turned around found find read reading " +
    "explained explain explainer thread question questions answer answers wiki wikipedia search google reddit youtube " +
    "com www http https org html people year years time times part"
  ).split(" "),
);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "");
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 4 && w.endsWith("es") && /(ch|sh|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") && !w.endsWith("us") && !w.endsWith("is")) return w.slice(0, -1);
  return w;
}

export function tokens(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
    .map(stem);
}

export function tokenSet(text: string): Set<string> {
  return new Set(tokens(text));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Share of `a`'s terms that also appear in `b`. */
export function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / a.size;
}

/**
 * Top terms across a set of documents, weighted by how many documents use
 * them (so a term that runs through the whole cluster beats one repeated in
 * a single page).
 */
export function keywords(docs: string[], limit = 5, background?: Map<string, number>): string[] {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(tokens(d))) df.set(t, (df.get(t) ?? 0) + 1);
  return [...df.entries()]
    .map(([t, n]) => [t, n / (1 + Math.log(1 + (background?.get(t) ?? 0)))] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([t]) => t);
}

/** Frequent two-word phrases ("hall effect", "rapid trigger"). */
export function phrases(docs: string[], limit = 5, minDocs = 2): string[] {
  const df = new Map<string, number>();
  for (const d of docs) {
    const words = normalize(d)
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const seen = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      const [a, b] = [words[i], words[i + 1]];
      if (STOP.has(a) || STOP.has(b) || a.length < 3 || b.length < 3) continue;
      const p = `${a} ${b}`;
      if (!seen.has(p)) {
        seen.add(p);
        df.set(p, (df.get(p) ?? 0) + 1);
      }
    }
  }
  return [...df.entries()]
    .filter(([, n]) => n >= minDocs)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([p]) => p);
}

export function sentences(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]+(?:["”’)]+)?|[^.!?]+$/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length > 2);
}

export function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
}

const QUESTION_START = /^(why|how|what|whats|what's|is|are|do|does|did|can|could|should|would|will|when|where|who|which)\b/i;

/** "are polymarket odds accurate" → "Are polymarket odds accurate?" */
export function asQuestion(s: string): string {
  const t = sentenceCase(s.replace(/[“”"]/g, "").replace(/\s+/g, " ").trim()).replace(/[.?!]+$/, "");
  return QUESTION_START.test(t) ? `${t}?` : t;
}

export function lowerFirst(s: string): string {
  if (!s) return s;
  // Keep acronyms and proper-looking words ("AWS", "Netflix") as they are.
  const first = s.split(" ")[0];
  if (/^[A-Z0-9]{2,}/.test(first) || /^[A-Z][a-z]+[A-Z]/.test(first)) return s;
  return /^[A-Z][a-z]/.test(first) && !PROPER.has(first) ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// Words that stay capitalised mid-sentence. Crude, but good enough for labels.
const PROPER = new Set([
  "Netflix", "Blockbuster", "Redbox", "Concorde", "Wooting", "Polymarket", "Kalshi", "Metaculus", "Titanic",
  "Tokyo", "Moscow", "Pantheon", "Roman", "Brier", "Kelly", "Tetlock", "Bayes", "Chaos", "SPARC", "ITER",
  "Figma", "Automerge", "Portra", "Kodak", "GeoCities", "Mario", "Tetris", "Mellotron", "Gruen", "Southdale",
  "Crandall", "Banham", "Boston", "Robarts", "UEA", "Olympus", "Boom", "Tu-144", "Wendelstein", "Commonwealth",
  "Good", "Superforecasting", "Harland", "Baskerville", "Comic", "Bloomberg", "Clearview", "Highway", "Atkinson",
  "Hall", "Cherry", "QMK", "RTINGS", "Mars", "Earth", "Kessler", "Nemo", "Space", "Swiss", "Spain", "Madrid",
  "Tashkent", "Mayakovskaya", "Komsomolskaya", "Reyner", "Victor", "Luis", "Aza", "Wayback", "Archive",
  "Library", "Lost", "SABRE", "ATPCO", "NDC", "LMSR", "AWS", "HTS", "REBCO", "NIF", "Lawson", "Hilfiker",
  "Mondaine", "Kellogg", "Bernays", "Granula", "Colemak", "Dvorak", "QWERTY", "DIN", "Ophiocordyceps",
]);

export function joinList(items: string[], conj = "and"): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} ${conj} ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, ${conj} ${items[items.length - 1]}`;
}

/** Stable small hash, for deterministic "random" choices. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
