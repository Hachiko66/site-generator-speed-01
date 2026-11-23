# site-generator-speed-01

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
257–486 files each). CPU time by `process.cpuUsage`, 9 runs each:

| | avg | min | max |
| --- | --- | --- | --- |
| makefun-site 1.0.0 (house baseline), `run()` only | 665.6 ms | 635.4 ms | 721.7 ms |
| this entry, `run()` only | 161.8 ms | 144.6 ms | 219.1 ms |

**4.11× faster on the work itself** (75.7% less CPU). End to end through the
`main.ts` driver in a fresh process per run — which also pays Node startup,
parsing the 2.9 MB `cases.json` and stringifying the 7.4 MB `answers.json`,
costs the do-nothing control nets out — the entry measures ~1.01–1.38 s of
CPU against the baseline's ~1.49–1.67 s (control ~0.29 s), so the official
net figure is roughly 1.4–1.8×; the fixed JSON cost dilutes the ratio, the
`run()` work underneath is the 4.11× above. Either way the entry is clearly
faster than the baseline on every run measured.

## Files

- `solve.js` — the entry (dependency-free ES module, `run(input)`).
- `main.ts` — the harness driver.
- `README.md` — this file.
- `LICENSE` — MIT.

## Limits

- No network, no model calls, no WebAssembly, no native addons: pure
  JavaScript, deterministic.
- Whole repository is far under the 4 MiB cap.
