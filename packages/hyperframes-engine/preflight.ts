/**
 * Determinism pre-flight for split rendering. A chunk is rendered by another browser on another machine, starting
 * cold at its first frame. That only gives the same pixels as one long render when every pixel is a function of
 * timeline time. This reads the project's HTML, its local scripts and CSS (no browser) and lists what usually breaks
 * that:
 *
 *   clock     Date.now(), performance.now(), new Date() with no argument: wall-clock time, not timeline time
 *   random    Math.random(): different on every machine unless the project seeds its own generator
 *   network   scripts, stylesheets and fonts loaded from http(s): another machine may get another version, or none
 *
 * Files listed in the project's vendor.lock.json (libraries taken in with scripts/vendor-scripts.mjs) are not read.
 *
 * Findings are warnings, not proof: a match inside a string is a false alarm, and a closure that keeps state from one
 * frame to the next is not found at all. `npm run compare` (one chunk against several, frame by frame) is the proof.
 *
 * What the engine does with them (render option `preflight`):
 *   "warn" (default)  any finding: render in one piece, with the reasons as a warning in the progress
 *   "off"             split anyway (you checked it with `npm run compare`)
 *   "strict"          refuse the render
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export type PreflightFinding = { kind: 'clock' | 'random' | 'network'; file: string; line: number; text: string };
export type PreflightMode = 'warn' | 'off' | 'strict';

/** Comments out, line numbers kept: a `Date.now()` in a comment that says "never Date.now()" is not a finding. */
export function stripComments(code: string, html: boolean): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  let out = html ? code.replace(/<!--[\s\S]*?-->/g, blank) : code;
  out = out.replace(/\/\*[\s\S]*?\*\//g, blank);
  // `//` comments, but not the `//` of a URL (preceded by a colon) or inside a quoted string on the same line.
  out = out.replace(/(^|[^:"'`\\])\/\/[^\n]*/g, (match, before: string) => before + blank(match.slice(before.length)));
  return out;
}

const RULES: { kind: PreflightFinding['kind']; pattern: RegExp }[] = [
  { kind: 'clock', pattern: /\bDate\.now\s*\(|\bperformance\.now\s*\(|\bnew\s+Date\s*\(\s*\)/g },
  { kind: 'random', pattern: /\bMath\.random\s*\(/g },
];
const NETWORK = [
  /<script\b[^>]*\bsrc\s*=\s*["']?(https?:)?\/\/[^"'\s>]+/gi,
  /<link\b[^>]*\bhref\s*=\s*["']?(https?:)?\/\/[^"'\s>]+/gi,
  /@import\s+(url\()?\s*["']?(https?:)?\/\/[^"')\s]+/gi,
  /url\(\s*["']?(https?:)?\/\/[^"')\s]+/gi,
];

function scan(text: string, file: string, html: boolean, findings: PreflightFinding[]) {
  const code = stripComments(text, html);
  const lineOf = (index: number) => code.slice(0, index).split('\n').length;
  for (const rule of RULES) for (const match of code.matchAll(rule.pattern)) findings.push({ kind: rule.kind, file, line: lineOf(match.index!), text: match[0] });
  const seen = new Set<number>();
  // One network finding per line: `@import url(https://...)` matches two patterns.
  for (const pattern of NETWORK) for (const match of code.matchAll(pattern)) { const line = lineOf(match.index!); if (!seen.has(line)) { seen.add(line); findings.push({ kind: 'network', file, line, text: match[0].slice(0, 120) }); } }
}

/** The project's index.html and the local scripts and stylesheets it names. */
export function preflight(projectDir: string): PreflightFinding[] {
  const root = resolve(projectDir);
  const html = readFileSync(join(root, 'index.html'), 'utf8');
  const findings: PreflightFinding[] = [];
  scan(html, 'index.html', true, findings);
  const local = [...html.matchAll(/<(?:script|link)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((match) => match[1]!).filter((path) => !/^([a-z]+:)?\/\//i.test(path) && /\.(m?js|css)$/i.test(path));
  // Libraries taken in with vendor-scripts.mjs are not the project's code: GSAP itself reads the clock and uses
  // Math.random() for its own utilities, and HyperFrames drives its timeline from virtual time.
  const lockPath = join(root, 'vendor.lock.json');
  const vendored = new Set<string>(existsSync(lockPath) ? (JSON.parse(readFileSync(lockPath, 'utf8')).files as { file: string }[]).map((entry) => resolve(root, entry.file)) : []);
  for (const path of local) {
    if (vendored.has(resolve(root, path))) continue;
    const file = resolve(root, path);
    if (file.startsWith(root) && existsSync(file)) scan(readFileSync(file, 'utf8'), path, false, findings);
  }
  // Seeded generators are common and fine: a project that defines one (mulberry32, sfc32, seedrandom, an LCG) and calls
  // Math.random() nowhere has no random finding anyway; one that does both still gets it.
  return findings;
}

/** One line per finding, for a warning or an error message. */
export const describe = (findings: PreflightFinding[]) => findings.map((finding) => `${finding.kind}: ${finding.file}:${finding.line} ${finding.text.trim()}`);

export const modeOf = (value: unknown): PreflightMode => (value === 'off' || value === 'strict' ? value : 'warn');
