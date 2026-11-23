// solve.js — v3, a byte-native drop-in for makefun-site 1.0.0 (site-generator-speed-01).
// Written from scratch for this bounty: same answers as makefun-site 1.0.0 for every
// input, faster. The reference is the vendor code in the kit; this file re-implements
// its rules (README.md of makefun-site 1.0.0) with the hot paths rewritten.
//
// v3's principle: never build a big string or a big object graph. All rendering
// writes bytes into one arena per case, and the answer JSON is emitted directly
// as bytes — no JSON.stringify over a 7.4 MB object, no 7.4 MB output tree.
// run(input) returns a Uint8Array holding the JSON bytes of the answer object
// for one site's input { site, templates, files }. The driver writes those
// bytes into /output/answers.json between "[" and "]" (the scorer reads the
// file as JSON values, so key order does not matter, though v3 keeps v2's
// construction order anyway).
//
// What is byte-native: the Markdown renderer (line-offset scanning, no
// split('\n'); inline rendering straight into the arena), the template engine
// (templates compiled once per case to flat bytecode, executed by a small VM
// that writes into the answer arena), and the answer emission (JSON escaping
// applied inline while copying bytes). What stays string-based, deliberately:
// JSON.parse of the input (native V8, fastest), String.normalize for NFKD
// (non-ASCII slugs only), date formatting, String(n), sorting, and the small
// report lines. Front matter keeps v2's line-offset scanner.
//
// No network, no model calls, no WebAssembly, no native addons: pure
// JavaScript, deterministic. Nothing is cached from one case to the next.

export function run(input) {
  return build(input);
}

// ---------------------------------------------------------------- the arena

/** A byte range: `s` is an offset into an arena, `l` its length in bytes. */
class Range {
  constructor(s, l) { this.s = s; this.l = l; }
}

/** A growable byte buffer: `b` is the storage, `n` the length used. */
class Buf {
  constructor(cap) { this.b = new Uint8Array(cap); this.n = 0; }
  // The slow path of ensure: double capacity until `need` fits. The fast
  // path (capacity suffices, the overwhelmingly common case) is inlined at
  // each call site as `if (out.n + need > out.b.length) out.grow(need)`, so
  // a write costs a comparison, not a method call.
  grow(need) {
    let cap = this.b.length * 2;
    while (this.n + need > cap) cap *= 2;
    const nb = new Uint8Array(cap);
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
  }
}

/** One byte. */
function writeByte(out, c) {
  if (out.n + 1 > out.b.length) out.grow(1);
  out.b[out.n++] = c;
}

/** An ASCII string's bytes (the caller guarantees every char is < 128). */
function writeAscii(out, str) {
  const len = str.length;
  if (out.n + len > out.b.length) out.grow(len);
  const b = out.b;
  let n = out.n;
  for (let i = 0; i < len; i++) b[n++] = str.charCodeAt(i);
  out.n = n;
}

/**
 * `str[a..b)` as UTF-8 bytes, no escaping. Long runs go through Buffer.from
 * (C++ encode, ~12x the per-char loop); short runs keep the per-char loop,
 * which is cheaper than an allocation for a handful of chars.
 */
function writeStrRange(out, str, a, b) {
  const len = b - a;
  if (len <= 0) return;
  if (len > 16) {
    const rest = Buffer.from(str.slice(a, b), 'utf8');
    if (out.n + rest.length > out.b.length) out.grow(rest.length);
    out.b.set(rest, out.n);
    out.n += rest.length;
    return;
  }
  if (out.n + len > out.b.length) out.grow(len);
  let n = out.n;
  const buf = out.b;
  let i = a;
  while (i < b) {
    const c = str.charCodeAt(i);
    if (c >= 128) break;
    buf[n++] = c;
    i++;
  }
  out.n = n;
  if (i < b) {
    const rest = Buffer.from(str.slice(i, b), 'utf8');
    if (out.n + rest.length > out.b.length) out.grow(rest.length);
    out.b.set(rest, out.n);
    out.n += rest.length;
  }
}

/** `src[s..e)` copied as-is. Safe when src is out's own buffer (the range ends before the cursor). */
function writeBytes(out, src, s, e) {
  const len = e - s;
  if (len <= 0) return;
  if (out.n + len > out.b.length) out.grow(len);
  out.b.set(src.subarray(s, e), out.n);
  out.n += len;
}

const HEX = '0123456789abcdef';

/** The \u00XX escape for a control char `c` (not one of \b \f \n \r \t). */
function writeUnicodeEscape(out, c) {
  if (out.n + 6 > out.b.length) out.grow(6);
  const b = out.b;
  let n = out.n;
  b[n++] = 92; // \
  b[n++] = 117; // u
  b[n++] = 48; // 0
  b[n++] = 48; // 0
  b[n++] = HEX.charCodeAt(c >> 4);
  b[n++] = HEX.charCodeAt(c & 15);
  out.n = n;
}

/**
 * `src[s..e)` (UTF-8 bytes) copied with JSON string escaping: " and \ escaped,
 * control chars as \b \f \n \r \t or \u00XX. Bytes >= 0x80 pass through: UTF-8
 * continuation and lead bytes are never a JSON special. Identical to what
 * JSON.stringify does to the same string.
 */
function copyJsonEscaped(out, src, s, e) {
  let i = s;
  while (i < e) {
    let j = i;
    while (j < e) {
      const c = src[j];
      if (c === 34 || c === 92 || c < 32) break;
      j++;
    }
    if (j > i) writeBytes(out, src, i, j);
    if (j >= e) break;
    const c = src[j];
    if (c === 34) writeAscii(out, '\\"');
    else if (c === 92) writeAscii(out, '\\\\');
    else if (c === 8) writeAscii(out, '\\b');
    else if (c === 9) writeAscii(out, '\\t');
    else if (c === 10) writeAscii(out, '\\n');
    else if (c === 12) writeAscii(out, '\\f');
    else if (c === 13) writeAscii(out, '\\r');
    else writeUnicodeEscape(out, c);
    i = j + 1;
  }
}

/**
 * `src[s..e)` (UTF-8 bytes) copied with HTML escaping and then JSON escaping
 * in one pass: & < > " ' become entities (HTML escaping first, as the
 * reference does), \ and control chars become JSON escapes. This is exactly
 * escapeHtml followed by JSON.stringify, for a byte range. One pass, no
 * allocation: cheaper than decode + escapeHtml + JSON.stringify + encode
 * (measured: the C++ round-trip cost ~13% of run(), this scan ~5.5%).
 */
function copyHtmlJsonEscaped(out, src, s, e) {
  let i = s;
  while (i < e) {
    let j = i;
    while (j < e) {
      const c = src[j];
      if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39 || c === 92 || c < 32) break;
      j++;
    }
    if (j > i) writeBytes(out, src, i, j);
    if (j >= e) break;
    const c = src[j];
    if (c === 38) writeAscii(out, '&amp;');
    else if (c === 60) writeAscii(out, '&lt;');
    else if (c === 62) writeAscii(out, '&gt;');
    else if (c === 34) writeAscii(out, '&quot;');
    else if (c === 39) writeAscii(out, '&#39;');
    else if (c === 92) writeAscii(out, '\\\\');
    else if (c === 8) writeAscii(out, '\\b');
    else if (c === 9) writeAscii(out, '\\t');
    else if (c === 10) writeAscii(out, '\\n');
    else if (c === 12) writeAscii(out, '\\f');
    else if (c === 13) writeAscii(out, '\\r');
    else writeUnicodeEscape(out, c);
    i = j + 1;
  }
}

/** `str[a..b)` HTML-escaped into the arena (raw bytes, no JSON escaping). */
function writeHtmlEscapedStrRange(out, str, a, b) {
  let i = a;
  while (i < b) {
    let j = i;
    while (j < b) {
      const c = str.charCodeAt(j);
      if (c === 38 || c === 60 || c === 62 || c === 34 || c === 39) break;
      j++;
    }
    if (j > i) writeStrRange(out, str, i, j);
    if (j >= b) break;
    const c = str.charCodeAt(j);
    if (c === 38) writeAscii(out, '&amp;');
    else if (c === 60) writeAscii(out, '&lt;');
    else if (c === 62) writeAscii(out, '&gt;');
    else if (c === 34) writeAscii(out, '&quot;');
    else writeAscii(out, '&#39;');
    i = j + 1;
  }
}

/**
 * A whole string, JSON-escaped, into the answer arena. Long strings go
 * through JSON.stringify (C++, the reference escaper, ~2.5x the per-byte
 * scan); short ones keep the one-pass ASCII loop. Identical bytes either
 * way, and identical to what JSON.stringify does to the same string.
 */
function writeJsonStr(out, str) {
  const len = str.length;
  if (len > 24) {
    const j = JSON.stringify(str);
    const buf = Buffer.from(j.slice(1, -1), 'utf8');
    if (out.n + buf.length > out.b.length) out.grow(buf.length);
    out.b.set(buf, out.n);
    out.n += buf.length;
    return;
  }
  if (out.n + len > out.b.length) out.grow(len);
  let n = out.n;
  const buf = out.b;
  let i = 0;
  while (i < len) {
    const c = str.charCodeAt(i);
    if (c >= 128 || c === 34 || c === 92 || c < 32) break;
    buf[n++] = c;
    i++;
  }
  out.n = n;
  if (i === len) return;
  const rest = Buffer.from(str.slice(i), 'utf8');
  copyJsonEscaped(out, rest, 0, rest.length);
}

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_TEST = /[&<>"']/;
const HTML_REPLACE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. Fast path: unchanged when it holds none. */
function escapeHtml(text) {
  if (!HTML_TEST.test(text)) return text;
  return text.replace(HTML_REPLACE, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** Whitespace codes (the \s set), as a table: WS[c] is 1 exactly for whitespace. */
const WS = new Uint8Array(65536);
for (const c of [9, 10, 11, 12, 13, 32, 160, 5760, 8232, 8233, 8239, 8287, 12288, 65279]) WS[c] = 1;
for (let c = 8192; c <= 8202; c++) WS[c] = 1;

/** Whether code `c` is a JavaScript whitespace character (the \s set). */
function isWSCode(c) {
  return WS[c] === 1;
}

/**
 * The slug of `text`, per makefun-site's rule: NFKD, combining marks dropped, A-Z
 * lowered, every run of other characters one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * `cache` is a per-build memo (same string, same slug); ASCII text skips the
 * normalize step, which is the identity on it. Kept string-based: slugs are
 * few per case, each computed once, and the ASCII fast path is already there.
 */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let plain;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (ascii) plain = text;
  else plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let k = 0; k < plain.length; k++) {
    const ch = plain[k];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  const slug = out === '' ? 'untitled' : out;
  cache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    while (i < len && isWSCode(text.charCodeAt(i))) i++;
    if (i >= len) break;
    n++;
    while (i < len && !isWSCode(text.charCodeAt(i))) i++;
  }
  return n;
}

/** `rel` from the directory `dirParts` (already split), or null when it climbs out. */
function resolveParts(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const TAG_BAD = new Set(['"', '[', ']']);

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function isKeyChar(c) {
  return (c >= 97 && c <= 122) || c === 95; // a-z _
}

function isNameChar(c) {
  return (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45; // a-z 0-9 -
}

function isDigit(c) {
  return c >= 48 && c <= 57;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, a real day from 1970-01-01 to 2099-12-31.
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          if (!isDigit(raw.charCodeAt(i))) { ok = false; break; }
        }
        if (ok) {
          y = Number(raw.slice(0, 4)); mo = Number(raw.slice(5, 7)); d = Number(raw.slice(8, 10));
          if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
        }
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) if (TAG_BAD.has(t[i])) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) if (!isNameChar(raw.charCodeAt(i))) return { error: 'key "layout": not a template name' };
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // a slug opens on a-z or 0-9, single "-" between
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Read by scanning line starts,
 * never splitting and re-joining the whole text.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // Find the closing "---" line; track line numbers (line 1 is the opening ---).
  let lineNo = 1; // the line we are about to read (0-based index + 1)
  let pos = 4; // just past "---\n"
  let closeLine = -1;
  let bodyStart = text.length;
  let p = pos;
  while (p <= text.length) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(p, end);
    lineNo++;
    if (line === '---') {
      closeLine = lineNo;
      bodyStart = nl === -1 ? text.length : nl + 1;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeLine === -1) return { error: 'the front matter is not closed' };
  const data = {};
  // Re-walk the front matter lines (line 2 .. closeLine - 1).
  let n = 2;
  p = pos;
  while (n < closeLine) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(p, end);
    // blank (spaces/tabs only) or a comment ("#" first)
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) {
      // "key: value": key of a-z and _, a colon, one space and the value.
      let k = 0;
      while (k < line.length && isKeyChar(line.charCodeAt(k))) k++;
      if (k === 0 || line.charCodeAt(k) !== 58) return { error: `line ${n} is not "key: value"` };
      const key = line.slice(0, k);
      let raw;
      if (k + 1 >= line.length) raw = '';
      else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
      else return { error: `line ${n} is not "key: value"` };
      // trailing spaces and tabs dropped
      let e = raw.length;
      while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
      if (e < raw.length) raw = raw.slice(0, e);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    n++;
    if (nl === -1) break;
    p = nl + 1;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ---------------------------------------------------------------- markdown

// Line helpers over a range (s, e) of a string. Same rules as v2's per-line
// functions, but on ranges so no line is ever sliced out of the body.

/** Whether the range is blank (spaces and tabs only). */
function isBlankRange(src, s, e) {
  for (let i = s; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence's language, or null when the range does not open one. */
function fenceLangRange(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return null;
  let i = s + 3;
  while (i < e) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = src.slice(s + 3, i);
  while (i < e) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether the range closes a fence (``` then spaces or tabs only). */
function isFenceCloseRange(src, s, e) {
  if (e - s < 3 || src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading range's level and text range, or null (a heading's text is never empty). */
function headingOfRange(src, s, e) {
  let n = 0;
  while (s + n < e && src.charCodeAt(s + n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let i = s + n;
  if (i >= e || (src.charCodeAt(i) !== 32 && src.charCodeAt(i) !== 9)) return null;
  while (i < e && (src.charCodeAt(i) === 32 || src.charCodeAt(i) === 9)) i++;
  let end = e;
  while (end > i && (src.charCodeAt(end - 1) === 32 || src.charCodeAt(end - 1) === 9)) end--;
  if (end === i) return null;
  return { depth: n, a: i, b: end };
}

/** Whether the range is a thematic break (--- or *** then spaces or tabs only). */
function isHrRange(src, s, e) {
  if (e - s < 3) return false;
  const c0 = src.charCodeAt(s);
  if (c0 !== 45 && c0 !== 42) return false;
  if (src.charCodeAt(s + 1) !== c0 || src.charCodeAt(s + 2) !== c0) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** An ordered-list marker's number and rest start, or null. */
function orderedOfRange(src, s, e) {
  let i = s;
  while (i < e && i - s < 9 && src.charCodeAt(i) >= 48 && src.charCodeAt(i) <= 57) i++;
  if (i === s) return null;
  if (i >= e || src.charCodeAt(i) !== 46) return null;
  if (i + 1 >= e || src.charCodeAt(i + 1) !== 32) return null;
  return { num: src.slice(s, i), rest: i + 2 };
}

/** Whether the range continues a list item (two or more spaces, then a non-space). */
function isContinuedRange(src, s, e) {
  let i = s;
  while (i < e && src.charCodeAt(i) === 32) i++;
  if (i - s < 2 || i >= e) return false;
  return !isWSCode(src.charCodeAt(i));
}

/** Whether the range ends a paragraph: blank, a fence, a heading or a thematic break. */
function endsParagraphRange(src, s, e) {
  return isBlankRange(src, s, e) || fenceLangRange(src, s, e) !== null || headingOfRange(src, s, e) !== null || isHrRange(src, s, e);
}

/** A range with spaces and tabs at either end dropped, as [a, b]. */
function trimRange(src, s, e) {
  let a = s;
  let b = e;
  while (a < b && (src.charCodeAt(a) === 32 || src.charCodeAt(a) === 9)) a++;
  while (b > a && (src.charCodeAt(b - 1) === 32 || src.charCodeAt(b - 1) === 9)) b--;
  return [a, b];
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` (bounded by `end`) where `s` holds `what` outside a backslash escape, or -1. */
function findUnescapedRange(s, what, from, end) {
  for (let j = from; j <= end - what.length; j++) {
    if (s[j] === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, bounded by `end`, or -1. */
function findSingleStarRange(s, from, end) {
  for (let j = from; j < end; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < end && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (j + 1 < end && s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[start..end)` rendered inline, straight into the arena (HTML-escaped).
 * One native scan for the next interesting character; plain runs between
 * specials are copied as-is (they hold no character that needs escaping), so
 * no per-character escape calls. The scanner regex is fresh per call: inline
 * recurses on ranges, and a shared regex would lose its place. Same rules as
 * v2's inline(), only the output goes to bytes instead of a string.
 */
function inlineRange(s, start, end, env, out) {
  const re = /[\\`*\[&<>"']/g;
  re.lastIndex = start;
  let plain = start;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    if (j >= end) break;
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < end && ESCAPABLE.has(s[j + 1])) {
        if (plain < j) writeStrRange(out, s, plain, j);
        writeByte(out, s.charCodeAt(j + 1)); // an escapable character is never an HTML special
        plain = j + 2;
        re.lastIndex = plain;
      } else {
        re.lastIndex = j + 1; // a lone backslash is itself
      }
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k !== -1 && k < end && k > j + 1) {
        if (plain < j) writeStrRange(out, s, plain, j);
        writeAscii(out, '<code>');
        writeHtmlEscapedStrRange(out, s, j + 1, k);
        writeAscii(out, '</code>');
        plain = k + 1;
        re.lastIndex = plain;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    if (c === '*') {
      if (j + 1 < end && s[j + 1] === '*') {
        const k = findUnescapedRange(s, '**', j + 2, end);
        if (k > j + 2) {
          if (plain < j) writeStrRange(out, s, plain, j);
          writeAscii(out, '<strong>');
          inlineRange(s, j + 2, k, env, out);
          writeAscii(out, '</strong>');
          plain = k + 2;
          re.lastIndex = plain;
        } else {
          re.lastIndex = j + 2;
        }
      } else {
        const k = findSingleStarRange(s, j + 1, end);
        if (k > j + 1) {
          if (plain < j) writeStrRange(out, s, plain, j);
          writeAscii(out, '<em>');
          inlineRange(s, j + 1, k, env, out);
          writeAscii(out, '</em>');
          plain = k + 1;
          re.lastIndex = plain;
        } else {
          re.lastIndex = j + 1;
        }
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescapedRange(s, ']', j + 1, end);
      const mm = k !== -1 && k + 1 < end && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 || mm >= end ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        if (plain < j) writeStrRange(out, s, plain, j);
        const href = escapeHtml(env.link(target));
        writeAscii(out, '<a href="');
        writeStrRange(out, href, 0, href.length);
        writeAscii(out, '">');
        inlineRange(s, j + 1, k, env, out);
        writeAscii(out, '</a>');
        plain = mm + 1;
        re.lastIndex = plain;
      } else {
        re.lastIndex = j + 1;
      }
      continue;
    }
    // An HTML special: & < > " '
    if (plain < j) writeStrRange(out, s, plain, j);
    writeAscii(out, ESCAPES[c]);
    plain = j + 1;
    re.lastIndex = plain;
  }
  if (plain < end) writeStrRange(out, s, plain, end);
}

/**
 * `src` rendered into the scratch arena: its HTML (each block on its own
 * lines, a "\n" after the last) as a Range, its table of contents (every
 * level 2 and 3 heading: level, id and its inline HTML as a Range) and its
 * excerpt (the first paragraph's inline HTML as a Range, or an empty Range).
 * Lines are found by offset, never split: the body is scanned once for its
 * line starts, and every block works on (start, end) ranges. The excerpt and
 * TOC html are sub-ranges of the page HTML itself, recorded as they are
 * rendered, so they cost nothing extra.
 */
function renderMarkdown(src, env, slugCache, scratch) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  const n = starts.length;
  const lend = (k) => (k + 1 < n ? starts[k + 1] - 1 : src.length);
  const htmlStart = scratch.n;
  let i = 0;
  while (i < n) {
    const s = starts[i];
    const e = lend(i);
    if (isBlankRange(src, s, e)) { i++; continue; }
    const lang = fenceLangRange(src, s, e);
    if (lang !== null) {
      writeAscii(scratch, '<pre><code');
      if (lang !== '') {
        const esc = escapeHtml(lang);
        writeAscii(scratch, ' class="language-');
        writeStrRange(scratch, esc, 0, esc.length);
        writeAscii(scratch, '"');
      }
      writeAscii(scratch, '>');
      let count = 0;
      i++;
      while (i < n && !isFenceCloseRange(src, starts[i], lend(i))) {
        if (count > 0) writeByte(scratch, 10);
        writeHtmlEscapedStrRange(scratch, src, starts[i], lend(i));
        count++;
        i++;
      }
      i++;
      if (count > 0) writeByte(scratch, 10);
      writeAscii(scratch, '</code></pre>\n');
      continue;
    }
    const heading = headingOfRange(src, s, e);
    if (heading !== null) {
      const text = src.slice(heading.a, heading.b);
      const id = uniqueSlug(slugify(text, slugCache), ids);
      writeAscii(scratch, `<h${heading.depth} id="`);
      writeAscii(scratch, id);
      writeAscii(scratch, '">');
      const r0 = scratch.n;
      inlineRange(src, heading.a, heading.b, env, scratch);
      const r1 = scratch.n;
      writeAscii(scratch, `</h${heading.depth}>\n`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html: new Range(r0, r1 - r0) });
      i++;
      continue;
    }
    if (isHrRange(src, s, e)) { writeAscii(scratch, '<hr>\n'); i++; continue; }
    if (src.charCodeAt(s) === 62) {
      let body = '';
      let count = 0;
      while (i < n && src.charCodeAt(starts[i]) === 62) {
        const ls = starts[i];
        const le = lend(i);
        let a = ls + 1;
        if (a < le && src.charCodeAt(a) === 32) a++;
        const t = trimRange(src, a, le);
        const ts = src.slice(t[0], t[1]);
        if (ts !== '') { if (count > 0) body += '\n'; body += ts; count++; }
        i++;
      }
      if (count === 0) writeAscii(scratch, '<blockquote>\n</blockquote>\n');
      else {
        writeAscii(scratch, '<blockquote>\n<p>');
        inlineRange(body, 0, body.length, env, scratch);
        writeAscii(scratch, '</p>\n</blockquote>\n');
      }
      continue;
    }
    const isBullet = (src.charCodeAt(s) === 45 || src.charCodeAt(s) === 42) && src.charCodeAt(s + 1) === 32;
    const ordered = !isBullet ? orderedOfRange(src, s, e) : null;
    if (isBullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const start = isOrdered ? Number(ordered.num) : 1;
      const items = [];
      while (i < n) {
        const ls = starts[i];
        const le = lend(i);
        if (isOrdered) {
          const m = orderedOfRange(src, ls, le);
          if (m !== null) {
            const tr = trimRange(src, m.rest, le);
            items.push(src.slice(tr[0], tr[1]));
            i++;
            continue;
          }
        } else if ((src.charCodeAt(ls) === 45 || src.charCodeAt(ls) === 42) && src.charCodeAt(ls + 1) === 32) {
          const tr = trimRange(src, ls + 2, le);
          items.push(src.slice(tr[0], tr[1]));
          i++;
          continue;
        }
        if (isContinuedRange(src, ls, le)) {
          const tr = trimRange(src, ls, le);
          items[items.length - 1] += '\n' + src.slice(tr[0], tr[1]);
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      if (isOrdered && start !== 1) writeAscii(scratch, `<ol start="${start}">\n`);
      else writeAscii(scratch, `<${tag}>\n`);
      for (const item of items) {
        writeAscii(scratch, '<li>');
        inlineRange(item, 0, item.length, env, scratch);
        writeAscii(scratch, '</li>\n');
      }
      writeAscii(scratch, `</${tag}>\n`);
      continue;
    }
    const t0 = trimRange(src, s, e);
    let text = src.slice(t0[0], t0[1]);
    i++;
    while (i < n && !endsParagraphRange(src, starts[i], lend(i))) {
      const tr = trimRange(src, starts[i], lend(i));
      text += '\n' + src.slice(tr[0], tr[1]);
      i++;
    }
    writeAscii(scratch, '<p>');
    const r0 = scratch.n;
    inlineRange(text, 0, text.length, env, scratch);
    const r1 = scratch.n;
    if (excerpt === null) excerpt = new Range(r0, r1 - r0);
    writeAscii(scratch, '</p>\n');
  }
  return { html: new Range(htmlStart, scratch.n - htmlStart), toc, excerpt: excerpt ?? new Range(0, 0) };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  markMemoizable(root.body, new Set());
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/**
 * A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "".
 * A byte Range materializes to its string (only ever reached if a Range sits inside an array join, which the data model never does).
 */
function textOf(v) {
  if (v instanceof Range) return Buffer.from(SCRATCH.b.subarray(v.s, v.s + v.l)).toString('utf8');
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array (an empty byte Range is ""). */
function truthy(v) {
  if (v instanceof Range) return v.l > 0;
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

// Names that are the same on every page render of one case (the site, the
// tag list, the recent list). A for-loop whose body only reads these, its own
// item and `loop` renders the same bytes for the same array, so it is
// rendered once per array and reused -- the recent-posts and tag lists a
// layout repeats on every page are the ones this saves.
const CASE_CONSTANTS = new Set(['site', 'tags', 'recent']);

/** Whether every value `nodes` reads is a name in `bound` (a for item of an enclosing loop), `loop`, or a case constant. */
function subtreeReadsOnly(nodes, bound) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0]) && n.path[0] !== 'loop' && !CASE_CONSTANTS.has(n.path[0])) return false;
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0]) && n.path[0] !== 'loop' && !CASE_CONSTANTS.has(n.path[0])) return false;
      if (!subtreeReadsOnly(n.then, bound)) return false;
      if (n.else !== null && !subtreeReadsOnly(n.else, bound)) return false;
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0]) && n.path[0] !== 'loop' && !CASE_CONSTANTS.has(n.path[0])) return false;
      const inner = new Set(bound);
      inner.add(n.name);
      if (!subtreeReadsOnly(n.body, inner)) return false;
    } else if (n.kind === 'include') {
      return false; // the included template's reads are not visible here
    }
  }
  return true;
}

/** Mark every for-node in `nodes` with `.memo`: true when its body reads only its own item, `loop` and case constants. */
function markMemoizable(nodes, bound) {
  for (const n of nodes) {
    if (n.kind === 'for') {
      const b = new Set(bound);
      b.add(n.name);
      n.memo = subtreeReadsOnly(n.body, b);
      markMemoizable(n.body, b);
    } else if (n.kind === 'if') {
      markMemoizable(n.then, bound);
      if (n.else !== null) markMemoizable(n.else, bound);
    }
  }
}

// ---------------------------------------------------------------- the template VM

// Opcodes. Every instruction is 5 slots: [op, a, b, c, d].
// TEXT: a = const index of the text. VAR/RAW: a = const index of the path.
// IF/IFNOT: a = const index of the path, b = pc to jump to when the branch is not taken.
// JMP: a = target pc. FOR: a = const index of the path, b = const index of the
// item name, c = pc just past ENDFOR, d = memo id (-1 when not memoizable).
// ENDFOR: no operands. INCLUDE: a = const index of the template name.
const OP = { TEXT: 0, VAR: 1, RAW: 2, IF: 3, IFNOT: 4, JMP: 5, FOR: 6, ENDFOR: 7, INCLUDE: 8 };

/** A parsed template's nodes compiled to flat bytecode: { code, consts, memos }. */
function compileTemplate(nodes) {
  const code = [];
  const consts = [];
  const memos = [];
  function emit(op, a, b, c, d) {
    code.push(op, a, b, c, d);
    return code.length - 5;
  }
  function walk(ns) {
    for (const n of ns) {
      if (n.kind === 'text') {
        // The text's JSON-escaped bytes, computed once per template at
        // compile time instead of once per render: the VM just copies them.
        const ci = consts.length;
        consts.push(Buffer.from(JSON.stringify(n.text).slice(1, -1), 'utf8'));
        emit(OP.TEXT, ci, 0, 0, 0);
      } else if (n.kind === 'var' || n.kind === 'raw') {
        const pi = consts.length;
        consts.push(n.path);
        emit(n.kind === 'var' ? OP.VAR : OP.RAW, pi, 0, 0, 0);
      } else if (n.kind === 'if') {
        const pi = consts.length;
        consts.push(n.path);
        const ifPc = emit(n.not ? OP.IFNOT : OP.IF, pi, 0, 0, 0);
        walk(n.then);
        if (n.else !== null) {
          const jmpPc = emit(OP.JMP, 0, 0, 0, 0);
          code[ifPc + 2] = code.length; // jumpFalse -> the else body
          walk(n.else);
          code[jmpPc + 1] = code.length; // jump -> past the else body
        } else {
          code[ifPc + 2] = code.length; // jumpFalse -> past the then body
        }
      } else if (n.kind === 'for') {
        const pi = consts.length;
        consts.push(n.path);
        const ni = consts.length;
        consts.push(n.name);
        let memoId = -1;
        if (n.memo === true) {
          memoId = memos.length;
          memos.push(new Map());
        }
        const forPc = emit(OP.FOR, pi, ni, 0, memoId);
        walk(n.body);
        emit(OP.ENDFOR, 0, 0, 0, 0);
        code[forPc + 3] = code.length; // endPc = just past ENDFOR
      } else if (n.kind === 'include') {
        const ni = consts.length;
        consts.push(n.name);
        emit(OP.INCLUDE, ni, 0, 0, 0);
      }
    }
  }
  walk(nodes);
  return { code, consts, memos };
}

/** A {{ }} value into the answer arena: HTML-escaped, then JSON-escaped. */
function writeVar(out, v) {
  if (v instanceof Range) {
    copyHtmlJsonEscaped(out, SCRATCH.b, v.s, v.s + v.l);
    return;
  }
  if (typeof v === 'number' || typeof v === 'boolean') {
    writeJsonStr(out, String(v)); // digits, true, false hold no HTML special
    return;
  }
  writeJsonStr(out, escapeHtml(textOf(v)));
}

/** A {{{ }}} value into the answer arena: raw, then JSON-escaped. */
function writeRaw(out, v) {
  if (v instanceof Range) {
    copyJsonEscaped(out, SCRATCH.b, v.s, v.s + v.l);
    return;
  }
  writeJsonStr(out, textOf(v));
}

/**
 * A compiled template executed into the answer arena `out` (every byte it
 * writes is JSON-escaped, because the layout output is one JSON string value
 * of the answer). `scope` is the scope chain ({ vars, parent }); `ctx` holds
 * the compiled templates; `depth` is the include depth. A flat loop with a
 * switch over integer opcodes: monomorphic, no object dispatch. A for-loop
 * runs through one scope, one vars object and one `loop` object, mutated per
 * item, as in v2. A memoizable loop renders once per array into the answer
 * arena and the byte range is reused for the same array afterwards.
 */
function runVM(prog, scope, ctx, depth, out) {
  const code = prog.code;
  const consts = prog.consts;
  let pc = 0;
  const frames = [];
  while (pc < code.length) {
    const op = code[pc];
    if (op === OP.TEXT) {
      const c = consts[code[pc + 1]];
      if (out.n + c.length > out.b.length) out.grow(c.length);
      out.b.set(c, out.n);
      out.n += c.length;
      pc += 5;
    } else if (op === OP.VAR) {
      writeVar(out, lookup(scope, consts[code[pc + 1]]));
      pc += 5;
    } else if (op === OP.RAW) {
      writeRaw(out, lookup(scope, consts[code[pc + 1]]));
      pc += 5;
    } else if (op === OP.IF) {
      pc = truthy(lookup(scope, consts[code[pc + 1]])) ? pc + 5 : code[pc + 2];
    } else if (op === OP.IFNOT) {
      pc = truthy(lookup(scope, consts[code[pc + 1]])) ? code[pc + 2] : pc + 5;
    } else if (op === OP.JMP) {
      pc = code[pc + 1];
    } else if (op === OP.FOR) {
      const xs = lookup(scope, consts[code[pc + 1]]);
      const memoId = code[pc + 4];
      const endPc = code[pc + 3];
      if (!Array.isArray(xs) || xs.length === 0) {
        if (Array.isArray(xs) && memoId >= 0) prog.memos[memoId].set(xs, new Range(out.n, 0));
        pc = endPc;
      } else if (memoId >= 0) {
        const hit = prog.memos[memoId].get(xs);
        if (hit !== undefined) {
          writeBytes(out, out.b, hit.s, hit.s + hit.l);
          pc = endPc;
        } else {
          const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
          const vars = { loop };
          vars[consts[code[pc + 2]]] = xs[0];
          const frame = { endPc, xs, k: 0, name: consts[code[pc + 2]], memoId, startCursor: out.n, bodyPc: pc + 5, child: { vars, parent: scope }, loop, vars };
          frames.push(frame);
          scope = frame.child;
          pc = pc + 5;
        }
      } else {
        const loop = { index: 1, first: true, last: xs.length === 1, length: xs.length };
        const vars = { loop };
        vars[consts[code[pc + 2]]] = xs[0];
        const frame = { endPc, xs, k: 0, name: consts[code[pc + 2]], memoId: -1, startCursor: out.n, bodyPc: pc + 5, child: { vars, parent: scope }, loop, vars };
        frames.push(frame);
        scope = frame.child;
        pc = pc + 5;
      }
    } else if (op === OP.ENDFOR) {
      const fr = frames[frames.length - 1];
      fr.k++;
      if (fr.k < fr.xs.length) {
        fr.vars[fr.name] = fr.xs[fr.k];
        fr.loop.index = fr.k + 1;
        fr.loop.first = false;
        fr.loop.last = fr.k === fr.xs.length - 1;
        pc = fr.bodyPc;
      } else {
        frames.pop();
        scope = fr.child.parent;
        if (fr.memoId >= 0) prog.memos[fr.memoId].set(fr.xs, new Range(fr.startCursor, out.n - fr.startCursor));
        pc += 5;
      }
    } else if (op === OP.INCLUDE) {
      const t = ctx.templates.get(consts[code[pc + 1]]);
      if (t !== undefined && depth < INCLUDE_DEPTH) runVM(t, scope, ctx, depth + 1, out);
      pc += 5;
    }
  }
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = ['posts', 'tags', 'page'];

/** `rel` (a link's path) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A page's link record as templates read it. */
function linkOf(s, slugCache) {
  if (s === null) return null;
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
  };
}

/** A post's card, as lists show it. The excerpt is a byte Range into the scratch arena. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page's record as templates read it. Content and TOC html are byte Ranges. */
function pageOf(s) {
  return {
    ...s.card,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

// The two arenas, reused across the cases of one process (each run() resets
// their cursors). run() returns a view of OUT; the driver writes it out
// before the next run() call, so reuse is safe.
const SCRATCH = new Buf(1 << 24);
const OUT = new Buf(1 << 24);

/** One site's answer as JSON bytes: the output tree, emitted straight into the answer arena. */
function build(input) {
  SCRATCH.n = 0;
  OUT.n = 0;
  const slugCache = new Map();
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, compileTemplate(parseTemplate(name, input.templates[name])));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
  };

  // 1. Sources, in code-unit order of their paths; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) {
      b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    } else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter: a refused source is reported and dropped, and so is a draft.
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) {
        b.report.push(`refused ${s.path}: ${fm.error}`);
        continue;
      }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
      if (own !== undefined) {
        b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
        continue;
      }
      if (s.post && !Object.hasOwn(s.data, 'date')) {
        b.report.push(`refused ${s.path}: a post needs a date`);
        continue;
      }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!b.templates.has(layout)) {
        b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
        continue;
      }
      s.layout = layout;
      if (s.data.draft === true) {
        b.report.push(`draft ${s.path}`);
        continue;
      }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. Permalinks: each page's output directory and url, its slug unique in its directory.
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${b.base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  // The HTML, excerpt and TOC html are byte Ranges into the scratch arena.
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const dirParts = dir === '' ? [] : dir.split('/');
      const env = {
        link: (target) => {
          if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolveParts(dirParts, rel);
          if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
          if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
          b.broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env, slugCache, SCRATCH);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    posts.forEach((p, k) => {
      p.newer = k === 0 ? null : posts[k - 1];
      p.older = k === posts.length - 1 ? null : posts[k + 1];
    });
  }

  // 6. The tags, grouped by their slug, named as first met in the posts' order.
  {
    const bySlug = new Map();
    const ownTags = (s) => {
      const seen = new Set();
      const out = [];
      for (const name of s.data.tags ?? []) {
        const slug = slugify(name, slugCache);
        if (!seen.has(slug)) {
          seen.add(slug);
          out.push(name);
        }
      }
      return out;
    };
    for (const p of b.posts) {
      p.tagRefs = [];
      for (const name of ownTags(p)) {
        const slug = slugify(name, slugCache);
        if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
        const tag = bySlug.get(slug);
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        s.tagRefs = ownTags(s).map((name) => {
          const slug = slugify(name, slugCache);
          return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
        });
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  // Emitted straight into the answer arena as JSON: "path":"content" pairs, in
  // v2's construction order. A layout's output is written by the VM directly
  // into the answer arena, JSON-escaped as it goes, so no page HTML string
  // and no output object graph are ever built.
  {
    const cards = new Map();
    for (const p of b.posts) {
      p.card = cardOf(p);
      cards.set(p, p.card);
    }
    for (const s of b.sources) if (!s.post) s.card = cardOf(s);
    const site = { title: b.input.site.title, base_url: b.base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, b.input.site.recent).map((p) => cards.get(p));
    const ctx = { templates: b.templates };
    const emitted = new Set();
    let first = true;
    const emitKey = (path) => {
      if (!first) writeByte(OUT, 44); // ,
      first = false;
      writeByte(OUT, 34); // "
      writeJsonStr(OUT, path);
      writeByte(OUT, 34); // "
      writeByte(OUT, 58); // :
      writeByte(OUT, 34); // " (the value string opens; the VM or a writer closes it)
      emitted.add(path);
    };
    const emitRendered = (path, name, vars) => {
      const prog = b.templates.get(name);
      if (prog === undefined) return;
      emitKey(path);
      runVM(prog, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, OUT);
      writeByte(OUT, 34); // " (the value string closes)
    };
    writeByte(OUT, 123); // {
    for (const s of b.sources) emitRendered(`${s.outDir}/index.html`, s.layout, { page: pageOf(s) });
    const per = b.input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      emitRendered(k === 1 ? 'index.html' : `page/${k}/index.html`, 'index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
    }
    for (const t of b.tags) {
      emitRendered(`tags/${t.slug}/index.html`, 'tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    }
    emitRendered('tags/index.html', 'tags', {});
    for (const f of b.statics) {
      if (emitted.has(f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else {
        emitKey(f.path);
        writeJsonStr(OUT, f.content);
        writeByte(OUT, 34);
      }
    }

    // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pageCount = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pageCount} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    emitKey(REPORT_FILE);
    writeJsonStr(OUT, `${lines.join('\n')}\n`);
    writeByte(OUT, 34);
    writeByte(OUT, 125); // }
  }

  return OUT.b.subarray(0, OUT.n);
}
