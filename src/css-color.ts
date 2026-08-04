// bot-relay-mcp
// Copyright (c) 2026 Lumiere Ventures
// SPDX-License-Identifier: MIT
// See LICENSE for full terms.

/**
 * Positive-grammar CSS color validation for dashboard theme tokens.
 *
 * Threat: a custom-theme token value feeds a CSS `background:` shorthand, which
 * accepts `url(...)` — so a hostile value (`url(https://attacker/x)`) fires an
 * external request from the operator's AUTHENTICATED dashboard (CSS beaconing /
 * defacement). LOW severity — post-ADR-0006 the theme write is authenticated, so
 * the realistic vector is an operator importing an untrusted shared theme blob.
 *
 * The rule is a POSITIVE GRAMMAR, never a denylist: match the permitted color
 * forms and refuse everything else. A denylist here cannot hold — the obvious
 * "reject `(`" rejects `rgb()`/`hsl()` too, and every new CSS function
 * (`color()`, `light-dark()`, `var()`, an escape like `\75 rl`, a comment-split
 * `url/**\/(...)`) would be admitted by default. With a positive grammar, a
 * future CSS feature is REFUSED by default rather than admitted by default.
 *
 * This is the STRICT, WRITE-side validator ("is this a known-good form?"). There
 * is a DELIBERATELY LIGHTER read-side counterpart — `isSafeThemeColor` in
 * src/dashboard.ts's applyTheme — which answers only "could this stored value
 * beacon?" and stays permissive enough to keep legacy themes (values stored
 * before this validation existed) applying. The two intentionally differ
 * (ADR-0015 L4); read that comment before unifying them.
 */

// #rgb / #rgba / #rrggbb / #rrggbbaa
const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

// rgb()/rgba()/hsl()/hsla() with a NUMERIC-and-separator-only interior: digits,
// dot, percent, comma, slash (modern space/slash alpha), whitespace. No letters
// (so no nested url()/var()), no second "(" (so no nesting), no ";" / "\" / "*".
const NUMERIC_FUNC = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%/\s]+\)$/i;

/** The CSS Color Module Level 4 named-color keyword set (closed) + the two keywords. */
const NAMED_COLORS: ReadonlySet<string> = new Set([
  "transparent", "currentcolor",
  "aliceblue","antiquewhite","aqua","aquamarine","azure","beige","bisque","black",
  "blanchedalmond","blue","blueviolet","brown","burlywood","cadetblue","chartreuse",
  "chocolate","coral","cornflowerblue","cornsilk","crimson","cyan","darkblue",
  "darkcyan","darkgoldenrod","darkgray","darkgreen","darkgrey","darkkhaki",
  "darkmagenta","darkolivegreen","darkorange","darkorchid","darkred","darksalmon",
  "darkseagreen","darkslateblue","darkslategray","darkslategrey","darkturquoise",
  "darkviolet","deeppink","deepskyblue","dimgray","dimgrey","dodgerblue","firebrick",
  "floralwhite","forestgreen","fuchsia","gainsboro","ghostwhite","gold","goldenrod",
  "gray","green","greenyellow","grey","honeydew","hotpink","indianred","indigo",
  "ivory","khaki","lavender","lavenderblush","lawngreen","lemonchiffon","lightblue",
  "lightcoral","lightcyan","lightgoldenrodyellow","lightgray","lightgreen","lightgrey",
  "lightpink","lightsalmon","lightseagreen","lightskyblue","lightslategray",
  "lightslategrey","lightsteelblue","lightyellow","lime","limegreen","linen","magenta",
  "maroon","mediumaquamarine","mediumblue","mediumorchid","mediumpurple",
  "mediumseagreen","mediumslateblue","mediumspringgreen","mediumturquoise",
  "mediumvioletred","midnightblue","mintcream","mistyrose","moccasin","navajowhite",
  "navy","oldlace","olive","olivedrab","orange","orangered","orchid","palegoldenrod",
  "palegreen","paleturquoise","palevioletred","papayawhip","peachpuff","peru","pink",
  "plum","powderblue","purple","rebeccapurple","red","rosybrown","royalblue",
  "saddlebrown","salmon","sandybrown","seagreen","seashell","sienna","silver","skyblue",
  "slateblue","slategray","slategrey","snow","springgreen","steelblue","tan","teal",
  "thistle","tomato","turquoise","violet","wheat","white","whitesmoke","yellow",
  "yellowgreen",
]);

/**
 * True iff `value` is a CSS color in one of the permitted forms: a hex color, a
 * numeric rgb()/rgba()/hsl()/hsla() function, or a named color from the closed
 * keyword set. Everything else — url(), var(), color(), escapes, comments,
 * semicolons, nested functions — is refused.
 */
export function isSafeCssColorValue(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > 64) return false;
  if (HEX.test(value)) return true;
  if (NUMERIC_FUNC.test(value)) return true;
  if (NAMED_COLORS.has(value.toLowerCase())) return true;
  return false;
}
