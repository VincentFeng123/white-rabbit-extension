/**
 * What marks a page as having ads in it: Google's ad script, its ad slots,
 * and its ad frames. White Rabbit never loads that script in a tab where the
 * extension or White Rabbit Helper is connected, and a tab that has any of
 * these anyway gets no browsing: the extension's content script stops
 * answering it (extension/src/bridge.ts), and the app stops reading into it
 * (./bridge adsInPage). One list, so both look for the same things.
 */
export const AD_MARKS = [
  'script[src*="googlesyndication.com"]',
  'script[src*="adsbygoogle"]',
  'script[src*="doubleclick.net"]',
  "ins.adsbygoogle",
  'iframe[src*="googlesyndication.com"]',
  'iframe[src*="doubleclick.net"]',
  'iframe[id^="aswift_"]',
  'iframe[id^="google_ads_iframe"]',
].join(", ");
