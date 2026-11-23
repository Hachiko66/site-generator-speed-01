# site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Hachiko66/site-generator-speed-01/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Hachiko66/site-generator-speed-01/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for **makefun-site 1.0.0** — the entry for the make.fun bounty
[Build a static site faster, 22 November 2026](https://make.fun/bounty/site-generator-speed-01-run-20261122)
(slug `site-generator-speed-01-run-20261122`).

`solve.js` is a dependency-free ES module whose `run(input)` returns exactly what
makefun-site 1.0.0's `build` returns for the same input: the output tree of every
path the site writes (each page's `index.html`, the index and tag pages,
`build-report.txt`, each static file) and that file's text, byte for byte.
`main.ts` is the harness driver: it reads every case from `/input/cases.json`,
answers each one alone with `run`, and writes `/output/answers.json`. It keeps
the house baseline driver's shape, including `--no-incremental-marking`
(the rules allow an entry to tune V8's flags the same way).

## What makefun-site 1.0.0 does

One generated site in, one output tree out. The input is `{ site, templates, files }`:
`site` holds the title, base URL, posts per index page and how many recent posts
templates see; `templates` are named sources in the site's own dialect (`{{ path }}`
escaped, `{{{ path }}}` raw, `{% for %}` / `{% if %}` / `{% include %}`, a tag
alone on its line taking the whole line); `files` are 200–600 Markdown sources
plus a few static files. The build reads every source's strict front matter
(seven known keys, the first failure refusing the file), drops drafts, makes each
page's slug unique in its directory (Unicode NFKD, combining marks dropped,
64 characters at most), renders each body's Markdown subset (fences, ATX headings
with slug ids, blockquotes, flat lists, paragraphs; inline code, strong, single-`*`
emphasis, links resolved to built pages and static files or reported broken),
groups posts into tags, paginates the index, renders every page through its
layout, and writes `build-report.txt` — every refusal, draft, broken link and
template that did not parse, sorted, then the counts. Nothing is cached from
one case to the next.

## Approach

Written from scratch against the reference's README and code (the kit's
`baselines/makefun-site/vendor/makefun-site/`); no reference code is copied into
this entry. The hot paths are rewritten, the rules are not:

- **Markdown inline, one native scan.** A single regex pass finds the next
  interesting character; plain runs between specials are copied as slices (they
  hold no character that needs escaping), so there is no per-character escape
  call. Code spans use a plain `indexOf`, link targets a plain `indexOf(')')`,
  and the scanner regex is fresh per call because `inline` recurses.
- **Escape fast path.** `escapeHtml` returns its input unchanged when it holds
  none of `& < > " '`, with no allocation.
- **Slugs memoized per build**, with an ASCII fast path that skips NFKD and the
  combining-mark replace (the identity on ASCII text).
- **Front matter by line offsets**, never splitting and re-joining the whole
  text; the value grammars (date, tags, layout, slug) are checked by hand
  instead of by regex, matching the reference's regexes exactly.
- **Templates parsed once per build** into a node tree; rendering walks the
  tree into a string accumulator (faster than an array plus a join for the
  many small chunks a page is made of).
- **Cards memoized per post** (a post's card is identical on every index and
  tag page that lists it) and the table of contents array reused directly.
- **No per-case state.** Every cache is created inside one `run` call and
  dropped with it.

v2 (this version) keeps every rule above and attacks the end-to-end number,
which v1's 4.11× `run()` win did not move nearly as much as it should have —
the driver, not `run()`, was the bottleneck:

- **Markdown in one fused pass.** The lexer and the renderer are one
  function that renders each block straight into the output string as it is
  met: no token objects, no block list, no second pass over the tokens. The
  output is identical (verified by the 204-input differential suite below);
  the garbage the tokens made — about 18% of `run()`'s cold CPU was the
  collector — is gone, and cold `run()` fell from ~605–690 ms to ~484–540 ms.
- **Template loops reuse one scope.** A `for` node renders all its items
  through a single scope, vars and `loop` object, mutated per item, instead of
  a fresh pair of objects per iteration.
- **Invariant fragments rendered once.** A `for` loop whose body reads only
  its own item, `loop`, and the per-case constants (`site`, `tags`, `recent`)
  renders the same string for the same array, so it is rendered once per array
  and reused: the recent-posts and tag lists a layout repeats on every page.
  The memo lives on the parsed node and dies with the case; nothing is cached
  from one case to the next.
- **Whitespace as a table.** `isWSCode` is a `Uint8Array` lookup instead of a
  boolean chain (word counting over all practice bodies: 15.0 ms vs 21.0 ms
  warm), which also speeds the word skipping the front-matter scanner does.
- **The driver streams its output.** `main.ts` stringifies and writes each
  case's answer as it is produced, instead of holding the whole answers array
  and stringifying 7.4 MB at once. The bytes written are identical to
  `JSON.stringify(answers)`; the peak live set stays one case, so the
  collector has far less to do (fresh-process practice set: ~947 ms vs
  ~1112 ms for the hold-everything driver).
- **A larger young generation.** `main.ts` also sets
  `--max-semi-space-size=64`: the build allocates many short-lived objects
  and fewer scavenges are measurably faster (~961 ms vs ~990 ms).

Two ideas were measured and **dropped**: a hand-rolled JSON writer for the
answers (byte-identical but slower than native `JSON.stringify`, 172 ms vs
96 ms warm) and a regex word counter (39 ms vs 29 ms warm). Only what moves
the end-to-end number stayed.

## Differential-test evidence

Every comparison is against makefun-site 1.0.0 itself (the kit's house
baseline `solve.js`), on inputs read back from the exact bytes an entry is
handed. **204 inputs, 0 mismatches — every answer byte-identical** (same JSON
values and the same key order):

| Set | Inputs | Result |
| --- | --- | --- |
| Kit practice set (3 cases, vs the kit's `expected.json` and the oracle) | 3 | 3/3 byte-identical |
| Generated with the kit's own generator (`draw.ts` / `sites.mjs`, fresh seeds) | 140 | 140/140 byte-identical |
| Hand-made edge cases (`edge.mjs` in the workspace, not in this repo) | 61 | 61/61 byte-identical |

The edge cases cover what the generator never draws: an empty site, statics
only, missing index/tag templates, templates that do not parse, includes
deeper than 8 and of missing templates, every front-matter refusal (unknown
key, duplicate key, bad dates, missing title, bad tags/slug/layout, quoted
strings with escapes at the end, a stray quote, a bad escape, a colon with no
space, an empty value), drafts, posts with no date, sources under `tags/` and
`page/`, Unicode and colliding slugs (including the reserved `posts`/`tags`/
`page` at the root and the 64-character cut), Markdown torture (setext lines,
unclosed fences, `***`, `**` with no closer, links to drafts/refusals/static
files/parents that climb out of the root), CRLF and CR-only endings, tag
grouping by slug across spellings, pagination (`per_page` 1 and 3, `recent` 0),
base URLs with no slash or many slashes, shadowed static files, empty code
blocks, headings with duplicate ids, a body with no paragraph, and the
`.markdown` / `.MD` extensions (only `.md` is a source).

One edge case caught a real bug during development: a quoted front-matter
value ending on an escaped quote (`title: "a\"`) is refused by the reference
— the fix was to match its exact escape rule, and the case now passes.

## Benchmark

Measured on this machine (Node v24.22.1) on the kit's practice set (3 cases,
257–486 files each). End to end through the `main.ts` driver in a fresh
process per run — Node startup, reading and parsing the 2.9 MB `cases.json`,
`run()` on all 3 cases, stringifying and writing the 7.4 MB `answers.json` —
CPU time by `resource.getrusage` on the child process, 7 runs each:

| | avg | median | min | max |
| --- | --- | --- | --- | --- |
| makefun-site 1.0.0 (house baseline) | 1730 ms | 1724 ms | 1620 ms | 1828 ms |
| this entry v1 | 1202 ms | 1204 ms | 1167 ms | 1256 ms |
| **this entry v2** | **980 ms** | **975 ms** | **941 ms** | **1059 ms** |

**v2 is 1.77× faster than the baseline end to end, and 18% faster than v1**
(1202 ms → 980 ms). The `run()` work underneath is faster too: warm,
in-process, median of 7 runs over the same 3 cases, v1 257 ms vs v2 188 ms.
Cold, `run()` alone fell from ~605–690 ms (v1) to ~484–540 ms (v2); the
streaming driver and the larger young generation account for the rest of the
end-to-end gain.

Honest note: this closes part of the gap, not all of it. v1's dev result was
rank #4,593 of 6,189, with the entry just ahead at 1,700,000 cpu_us and the
10th-place reward line at 190,000 cpu_us. v2's ~18% end-to-end gain moves the
rank up, but the reward line is still roughly 5× below v2's local number, and
the server's scale runs higher than this machine's. The remaining gap is
dominated by fixed costs no pure-JavaScript entry can remove — Node startup,
parsing the multi-megabyte input and stringifying the multi-megabyte output —
and by `run()` itself, whose cold cost is mostly JIT warm-up and collection.
The entries at the reward line advertise native/WASM engines in their titles,
which the competition's own requirements forbid ("no WebAssembly, native
addon or prebuilt binary"); whether those entries are disqualified in the
final is what decides whether a legal pure-JavaScript entry can reach the top
10 at all.

## Files

- `solve.js` — the entry (dependency-free ES module, `run(input)`).
- `main.ts` — the harness driver.
- `README.md` — this file.
- `LICENSE` — MIT.

## Limits

- No network, no model calls, no WebAssembly, no native addons: pure
  JavaScript, deterministic.
- Whole repository is far under the 4 MiB cap.
