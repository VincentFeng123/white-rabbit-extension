/**
 * Types, storage, and settings shared by the background script, popup, and
 * content script. Everything here lives in the extension's local storage, on
 * this device only.
 */

import type { DetectEvent, Sensitive } from "../../src/lib/capture/detect";
import type { CapturedTab } from "../../src/lib/capture/snapshot";

// Only the handful of WebExtension APIs this extension uses are touched;
// typed loosely here to avoid pulling @types/chrome into the app's toolchain.
declare global {
  const chrome: any;
  const browser: any;
  /** Injected at build time (extension/build.mjs). */
  const __APP_ORIGINS__: string[];
  const __TARGET__: "chrome" | "firefox" | "safari";
  const __VERSION__: string;
}

/** Firefox and Safari expose `browser` with promises; Chromium's `chrome` has promises in MV3 too. */
export const ext: any = typeof browser !== "undefined" ? browser : chrome;

/** The White Rabbit sites this build talks to. The first is where "Open White Rabbit" goes. */
export const APP_ORIGINS: string[] = __APP_ORIGINS__;
export const APP_ORIGIN = APP_ORIGINS[0];
export const TARGET = __TARGET__;
export const VERSION = __VERSION__;

export interface Settings {
  enabled: boolean;
  pausedUntil: number | "indefinite" | null;
  pausedFrom: number | null;
  blockedDomains: string[];
  excluded: Sensitive[];
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  pausedUntil: null,
  pausedFrom: null,
  blockedDomains: ["bankofamerica.com", "mail.google.com", "mychart.org"],
  excluded: ["banking", "medical", "email", "work", "passwords", "adult"],
};

export interface SuggestionSummary {
  id: string;
  topic: string;
  pages: number;
  minutes: number;
  endedAt: string;
}

export type Decision = "reviewed" | "ignored";

/** What the extension hands the app: raw pages and tabs, already filtered by every rule. */
export interface RawCapture {
  browser: string;
  from: string;
  to: string;
  pages: DetectEvent[];
  tabs: CapturedTab[];
}

export interface Store {
  settings: Settings;
  events: DetectEvent[];
  decisions: Record<string, Decision>;
  suggestions: SuggestionSummary[];
  /** Set when the person clicks Review; handed to the app once, then cleared. */
  pendingReview: { topic: string; minutes: number; pages: DetectEvent[] } | null;
}

export async function load(): Promise<Store> {
  const raw = await ext.storage.local.get([
    "settings",
    "events",
    "decisions",
    "suggestions",
    "pendingReview",
  ]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) },
    events: raw.events ?? [],
    decisions: raw.decisions ?? {},
    suggestions: raw.suggestions ?? [],
    pendingReview: raw.pendingReview ?? null,
  };
}

export async function save(patch: Partial<Store>): Promise<void> {
  await ext.storage.local.set(patch);
}

export function isPaused(s: Settings, now = Date.now()): boolean {
  if (s.pausedUntil === "indefinite") return true;
  return typeof s.pausedUntil === "number" && s.pausedUntil > now;
}

/** Rules the app asks for on top of the extension's own. */
export interface ExtraRules {
  blockedDomains?: string[];
  excluded?: Sensitive[];
}

export type Message =
  | { type: "status" }
  | { type: "pause"; until: number | "indefinite" }
  | { type: "resume" }
  | { type: "review"; id: string }
  | { type: "ignore"; id: string }
  | { type: "capture"; hours: number; rules?: ExtraRules }
  | { type: "pull" }
  | { type: "forget" }
  | { type: "hello" }
  | { type: "lookBack" };
