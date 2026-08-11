// Extracts named function source directly from the real index.html at test
// time, rather than maintaining a separately-copied implementation that
// could quietly drift from what's actually deployed.
//
// This is a deliberate fit for this specific codebase, not a workaround:
// CryptoPulse has no build step by design (a single static HTML file
// deployed as-is to GitHub Pages) and all logic lives inline in <script>
// tags rather than importable modules. A conventional "import the function"
// test setup would mean either introducing a build step this app has
// repeatedly, deliberately avoided, or maintaining a second copy of every
// tested function that has to be kept in sync by hand. Extracting from the
// live file means a test can NEVER pass against code that isn't what's
// actually shipped -- if a function's source changes, the test either still
// passes against the new source or fails, but it's always testing reality.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = join(__dirname, '..', '..', 'index.html');

let _cachedHtml = null;
function getHtml() {
  if (_cachedHtml === null) _cachedHtml = readFileSync(INDEX_HTML_PATH, 'utf8');
  return _cachedHtml;
}

// Concatenates every inline <script> block (excluding external src=
// scripts) in document order -- some functions/constants this codebase
// depends on live in earlier script blocks than the main application logic
// (e.g. PRICE_HISTORY, SEED_TXS are seeded in an earlier block than most
// functions that use them).
export function getFullScriptSource() {
  const html = getHtml();
  const scriptRe = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  const blocks = [];
  let m;
  while ((m = scriptRe.exec(html)) !== null) blocks.push(m[1]);
  if (!blocks.length) throw new Error('No inline <script> blocks found in index.html -- did the file structure change?');
  return blocks.join('\n;\n');
}

// Extracts one or more named function declarations (by exact function name)
// from the full script source, in the order given. Matches `function name(`
// through to its balanced closing brace -- handles nested braces correctly
// (needed for anything with an object literal or nested block in its body).
export function extractFunctions(...names) {
  const src = getFullScriptSource();
  const pieces = [];
  for (const name of names) {
    const startMatch = src.match(new RegExp(`function\\s+${name}\\s*\\(`));
    if (!startMatch) throw new Error(`Could not find "function ${name}(" in index.html -- was it renamed or removed?`);
    const startIdx = startMatch.index;
    const braceStart = src.indexOf('{', startIdx);
    if (braceStart === -1) throw new Error(`Could not find opening brace for ${name}`);
    let depth = 0, i = braceStart;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    pieces.push(src.slice(startIdx, i));
  }
  return pieces.join('\n\n');
}

// Extracts a top-level const/let declaration by name (e.g. `const START=...;`
// or a large embedded data object like PRICE_HISTORY/SEED_TXS). Matches up
// to the first top-level `;` at brace-depth 0 -- correct for both simple
// values and large embedded array/object literals.
export function extractConst(name) {
  const src = getFullScriptSource();
  const re = new RegExp(`(?:const|let)\\s+${name}\\s*=`);
  const m = src.match(re);
  if (!m) throw new Error(`Could not find "const/let ${name} =" in index.html`);
  const startIdx = m.index;
  let depth = 0, i = startIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{' || c === '[' || c === '(') depth++;
    else if (c === '}' || c === ']' || c === ')') depth--;
    else if (c === ';' && depth === 0) { i++; break; }
  }
  return src.slice(startIdx, i);
}

// Evaluates a set of extracted source pieces together in one scope, with a
// minimal DOM/browser stub sufficient for pure-computation functions (which
// don't touch the DOM at all, but may be declared alongside code that
// references `document`/`window` elsewhere in the same script block -- this
// just needs to not throw at parse/hoist time, not actually simulate a page).
export function evalInScope(source, extraGlobals = {}) {
  const sandbox = { console, ...extraGlobals };
  const keys = Object.keys(sandbox);
  const fn = new Function(...keys, `${source}\nreturn { ${extractTopLevelNames(source).join(',')} };`);
  return fn(...keys.map(k => sandbox[k]));
}

// Best-effort extraction of top-level `function name(` and `const name =`
// identifiers from a source blob, so evalInScope can return them without
// the caller having to list every name twice.
function extractTopLevelNames(source) {
  const names = new Set();
  for (const m of source.matchAll(/^function\s+([A-Za-z_$][\w$]*)\s*\(/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=/gm)) names.add(m[1]);
  return [...names];
}
