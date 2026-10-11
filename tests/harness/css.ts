/**
 * A small, strict reader for the studio's flat stylesheets, for the convention guard (I12) and the markup/CSS check
 * (A7.8). It understands rules, grouping and statement at-rules, and selector-less bodies (@keyframes, @font-face);
 * anything else (nesting, unbalanced braces) is reported as a violation instead of guessed at.
 */

export interface CssRule {
  /** The selector list, or null for an at-rule whose body holds declarations only (@keyframes, @font-face). */
  selector: string | null;
  body: string;
}

const SELECTORLESS_AT_RULES = /^@(?:-\w+-)?(?:keyframes|font-face|property|page|counter-style)\b/;

/** Drops comments and the contents of strings, so `[href="#top"]` or `content: "}"` cannot be mistaken for syntax. */
export function stripCommentsAndStrings(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

export function parseCss(source: string): { rules: CssRule[]; problems: string[] } {
  const rules: CssRule[] = [];
  const problems: string[] = [];
  const css = stripCommentsAndStrings(source);
  const opens = (css.match(/\{/g) ?? []).length;
  const closes = (css.match(/\}/g) ?? []).length;
  if (opens !== closes) problems.push(`unbalanced braces: ${opens} "{" and ${closes} "}"`);

  const walk = (text: string): void => {
    let i = 0;
    while (i < text.length) {
      while (i < text.length && /\s/.test(text[i]!)) i++;
      if (i >= text.length) break;
      const open = text.indexOf("{", i);
      const semi = text.indexOf(";", i);
      if (text[i] === "@" && semi >= 0 && (open < 0 || semi < open)) {
        i = semi + 1; // @import "x"; @charset "utf-8";
        continue;
      }
      if (open < 0) {
        problems.push(`stray text outside any rule: "${text.slice(i).trim().slice(0, 40)}"`);
        return;
      }
      let depth = 1;
      let close = open + 1;
      while (close < text.length && depth > 0) {
        if (text[close] === "{") depth++;
        else if (text[close] === "}") depth--;
        close++;
      }
      if (depth > 0) return; // reported above as unbalanced
      const prelude = text.slice(i, open).trim();
      const body = text.slice(open + 1, close - 1);
      if (prelude.startsWith("@")) {
        if (SELECTORLESS_AT_RULES.test(prelude)) rules.push({ selector: null, body });
        else walk(body);
      } else {
        if (body.includes("{")) problems.push(`"${prelude}" nests rules; write flat selectors`);
        rules.push({ selector: prelude, body });
      }
      i = close;
    }
  };
  walk(css);
  return { rules, problems };
}

/** Splits a selector list on top-level commas (commas inside (...) or [...] stay). */
function splitSelectorList(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i]!;
    if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** The compound selectors of one selector, with :not/:is/:where/:has unwrapped (their arguments are selectors too). */
function compounds(selector: string): string[] {
  let s = selector;
  const unwrap = /:(?:not|is|where|has)\(([^()]*)\)/;
  while (unwrap.test(s)) s = s.replace(unwrap, " $1 ");
  s = s.replace(/\([^()]*\)/g, ""); // :nth-child(2n+1), :lang(en), ...
  return s.split(/[\s>+~,]+/).filter(Boolean);
}

const NAMED_COLOURS =
  "aqua|black|blue|fuchsia|gray|grey|green|lime|maroon|navy|olive|orange|pink|purple|red|silver|teal|white|yellow";
const LITERAL_COLOUR = new RegExp(
  `#[0-9a-fA-F]{3,8}\\b|\\b(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\\(|(?::|\\s|,|\\()(?:${NAMED_COLOURS})(?=[\\s,;)]|$)`,
  "i",
);

export interface CssPolicy {
  /** base.css: may use element selectors. */
  allowElementSelectors: boolean;
  /** theme.css: may define literal colours. */
  allowLiteralColours: boolean;
}

/** Everything wrong with one stylesheet under the studio's conventions. Empty when it conforms. */
export function cssViolations(file: string, source: string, policy: CssPolicy): string[] {
  const out: string[] = [];
  const { rules, problems } = parseCss(source);
  for (const p of problems) out.push(`${file}: ${p}`);
  if (/!\s*important/i.test(stripCommentsAndStrings(source))) {
    out.push(`${file}: !important makes the next override impossible; fix the specificity instead`);
  }
  for (const { selector, body } of rules) {
    if (selector !== null) {
      for (const one of splitSelectorList(selector)) {
        if (/#[A-Za-z_-]/.test(one)) out.push(`${file}: "${one}" styles an ID; use a class (IDs are for scripts and tests)`);
        if (!policy.allowElementSelectors) {
          for (const compound of compounds(one)) {
            if (/^[A-Za-z*]/.test(compound)) {
              out.push(`${file}: "${one}" has the element selector "${compound}"; give the element a class, or move the rule to base.css`);
            }
          }
        }
      }
    }
    if (!policy.allowLiteralColours) {
      for (const declaration of body.split(";")) {
        const value = declaration.slice(declaration.indexOf(":") + 1);
        if (declaration.includes(":") && LITERAL_COLOUR.test(`:${value}`) && !/^\s*(?:transparent|currentcolor|inherit|initial|unset)\s*$/i.test(value)) {
          out.push(`${file}: "${selector ?? "at-rule"}" has a literal colour in "${declaration.trim()}"; add a token to theme.css`);
        }
      }
    }
  }
  return out;
}

/** Every class a stylesheet's selectors mention. */
export function cssClasses(source: string): Set<string> {
  const classes = new Set<string>();
  for (const { selector } of parseCss(source).rules) {
    if (selector === null) continue;
    for (const m of selector.matchAll(/\.(-?[A-Za-z_][\w-]*)/g)) classes.add(m[1]!);
  }
  return classes;
}
