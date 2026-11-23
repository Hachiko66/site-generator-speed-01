// main.ts — harness driver for this entry (solve.js).
// Kept from the house baseline's driver: the harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.
//
// One change from the baseline's driver: the answers are stringified and
// written one case at a time, as each is produced, instead of holding the
// whole answers array and stringifying 7.4 MB at once. The bytes written are
// identical to JSON.stringify(answers) -- a JSON array is "[" + the cases'
// stringified answers joined by "," + "]" -- and each case is still answered
// alone, nothing carried from one case to the next. It is measurably faster
// end to end (fresh-process practice set: ~947 ms vs ~1112 ms for the
// hold-everything driver), because the peak live set stays one case instead
// of the whole array plus its 7.4 MB string, so the garbage collector has far
// less to do.

import { readFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it (the rules: the house baseline runs with
// --no-incremental-marking, and an entry may tune V8's flags too). A larger
// young generation (64 MB semi-spaces) is also set: the build allocates many
// short-lived objects, and fewer scavenges are measurably faster end to end
// (fresh-process practice set: ~961 ms vs ~990 ms without it).
setFlagsFromString('--no-incremental-marking --max-semi-space-size=64');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
mkdirSync(OUTPUT_DIR, { recursive: true });
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let k = 0; k < cases.length; k++) {
  if (k > 0) writeSync(fd, ',');
  writeSync(fd, JSON.stringify(run(cases[k].input)));
}
writeSync(fd, ']');
closeSync(fd);
