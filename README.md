# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Hachiko66/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Hachiko66/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A byte-native drop-in for **makefun-site 1.0.0** — the v3 entry for the make.fun bounty
[Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122)
(slug `site-generator-speed-01-run-20261122`).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly what
makefun-site 1.0.0's `build` returns for the same input — as JSON **bytes**, not
as an object (see the contract change below). `main.ts` is the harness driver:
it reads every case from `/input/cases.json`, answers each one alone with `run`,
and writes `/output/answers.json`. It keeps the house baseline driver's shape,
including `--no-incremental-marking` (the rules allow an entry to tune V8's
flags the same way) and `--max-semi-space-size=64`.

## The contract change (run returns bytes)

`run(input)` returns a `Uint8Array` holding the JSON bytes of one case's answer
object — the output tree of every path the site writes (each page's
`index.html`, the index and tag pages, `build-report.txt`, each static file)
and that file's text, byte for byte. The driver writes `[`, then each case's
bytes separated by `,`, then `]` via `writeSync` (which accepts a `Uint8Array`).
The scorer reads `/output/answers.json` as JSON values, so the answers are the
same values v2 wrote; the key order is also kept identical to v2's
construction order (pages → index → tag → tags/index.html → statics →
build-report.txt last). Each case is still answered alone, nothing carried
from one case to the next. The win: no `JSON.stringify` of a 7.4 MB object
graph, and the peak live set stays one case's bytes.

## What is byte-native, and what stayed string-based

**Byte-native.** All rendering writes bytes into one arena per case, and the
answer JSON is emitted directly as bytes.

- **The byte arena (`Buf`).** One growable `Uint8Array` plus a cursor, doubled
  when full. Two arenas per process, reused across cases (each `run()` resets
  their cursors): `SCRATCH` for rendered page HTML, excerpts and TOC html;
  `OUT` for the answer JSON. The capacity check is inlined at each write site
  (a comparison, not a method call); growth is the rare slow path.
- **The Markdown renderer.** No `split('\n')`: blocks are scanned by line
  offsets (`indexOf('\n')`) over `(start, end)` ranges, and inline rendering
  writes straight into the arena. Long string runs go through `Buffer.from`
  (C++ UTF-8 encode); short runs keep a per-char loop (cheaper than an
  allocation for a handful of chars). A page's HTML, its excerpt and its TOC
  html are byte `Range`s (offset + length) into the scratch arena — never
  materialised as strings. Templates that read them get the range, and a
  `VAR`/`RAW` writes the range's bytes with escaping applied inline.
- **Templates → bytecode VM.** Each template is compiled once per case to
  flat instructions (one `Int32Array` code + a consts array): `TEXT`, `VAR`,
  `RAW`, `IF`/`IFNOT`, `JMP`, `FOR`, `ENDFOR`, `INCLUDE`. Execution is a flat
  loop with a switch over integer opcodes. Template `TEXT` chunks are
  JSON-escaped **once at compile time** and stored as buffers, so the VM just
  copies them. Scope keeps v2's chain objects (`{ vars, parent }`); the
  invariant-for memo renders once per array and stores the result as a byte
  range in the answer arena. Includes recurse with depth limit 8, as in v2.
- **The answer emission.** Pages render directly into the answer arena with
  JSON escaping applied while copying (`copyJsonEscaped`, one pass, no
  allocation). No page HTML string and no output object graph are ever built.
  Long strings go through `JSON.stringify` (C++, the reference escaper);
  short ones keep a one-pass ASCII loop. Both produce identical bytes.

**String-based, deliberately.** `JSON.parse` of the input (native V8,
fastest — no hand-written JSON parser in JS). `String.normalize` for NFKD
(non-ASCII slugs only). Date formatting, `String(n)`, sorting by code units,
the small report lines. Front matter keeps v2's line-offset scanner. All
non-ASCII template variable values go through the string fallback path.

**Determinism.** Answer key order follows the fixed construction order; no
`Date.now`/random; two executions produce identical bytes.

## What makefun-site 1.0.0 does

One generated site in, one output tree out. The input is `{ site, templates,
files }`: `site` holds the title, base URL, posts per index page and how many
recent posts templates see; `templates` are named sources in the site's own
dialect (`{{ path }}` escaped, `{{{ path }}}` raw, `{% for %}` / `{% if %}` /
`{% include %}`, a tag alone on its line taking the whole line); `files` are
200–600 Markdown sources plus a few static files. The build reads every
source's strict front matter (seven known keys, the first failure refusing
the file), drops drafts, makes each page's slug unique in its directory
(Unicode NFKD, combining marks dropped, 64 characters at most), renders each
body's Markdown subset (fences, ATX headings with TOC, blockquotes, lists,
paragraphs, inline code/emphasis/links/images), resolves links to pages and
static files (anything else is a broken link, reported), sorts posts newest
first, groups tags, renders every page through its layout, the index and tag
pages through theirs, and writes `build-report.txt` last. A refused file is
reported and dropped; a template that does not parse is reported and refused
as a layout.

## Honest numbers (measured 2026-11-23, Node v24.22.1, kit practice set)

Differential: **204/204 byte-identical** to the oracle (3 practice + 140
generated + 61 edge cases, 0 mismatches), including the quoted-escape edge
title. `makefun check` and kit grade-local are run by the submitter (see below).

Warm `run()` × 3 cases, median of 7 (in-process): v1 ~225 ms, **v2 ~132 ms,
v3 ~185 ms**. Cold `run()` × 3 in a fresh process: v2 445–510 ms,
**v3 626–646 ms**. End to end through the real driver in a fresh process,
7 runs each: baseline 1,446 ms avg, v2 ~730–758 ms avg, **v3 ~832–902 ms avg**.

So the honest verdict: **v3 is faster than the baseline (1.74×) and than v1,
but ~10–20% slower than v2 end to end, and it does not reach the reward
line (90,000 µs).** The byte emission really is cheap — 19–20 ms where
v2's `JSON.stringify` costs 207–277 ms, and the heap is ~22–26 MB where v2's
is ~59 MB — but the byte writing costs more than it saves: every write is a
JS function call plus a capacity check, where v2's string `+=` is an inline
rope append, and V8's `JSON.stringify` is one efficient C++ pass while v3
fragments the escaping into per-page, per-range operations. The design's
estimate (local ~450–600 ms, about 2× v2) did **not** hold. v2 remains the
better entry; v3 is kept here as a correct, verified byte-native
implementation, not as a submission candidate.

## Files

- `solve.js` — the entry (dependency-free, pure JS, no WASM, no native addon).
- `main.ts` — the harness driver.
- `README.md` — this file.
- `LICENSE` — MIT.
