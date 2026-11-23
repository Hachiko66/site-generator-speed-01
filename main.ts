// main.ts — harness driver for this entry (solve.js).
// Kept from the house baseline's driver: the harness runs `node /bot/main.ts`
// (node22). It reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one alone with run() from solve.js, and writes
// /output/answers.json: a JSON array of the answers, one per case and in the
// cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR
// stand in for /input and /output.
//
// Contract change from v2: run() returns a Uint8Array holding the JSON bytes
// of one case's answer object, not the object itself. The driver writes "[",
// then each case's bytes separated by ",", then "]" via writeSync. The bytes
// written are a JSON array whose values are the same answers v2 wrote (the
// scorer reads /output/answers.json as JSON values, and v3 emits keys in the
// same construction order v2 did), and each case is still answered alone,
// nothing carried from one case to the next. The win: no JSON.stringify of a
// 7.4 MB object graph, and the peak live set stays one case's bytes.
//
// V8 flags: --no-incremental-marking (the house baseline runs with it, and an
// entry may tune V8's flags too) and --max-semi-space-size=64 (fewer
// scavenges over the build's many short-lived objects), set before solve.js
// is imported so all of its work runs under them.

import { readFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking --max-semi-space-size=64');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract: run returns the answer's JSON bytes. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => Uint8Array };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
mkdirSync(OUTPUT_DIR, { recursive: true });
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
writeSync(fd, '[');
for (let k = 0; k < cases.length; k++) {
  if (k > 0) writeSync(fd, ',');
  writeSync(fd, run(cases[k].input));
}
writeSync(fd, ']');
closeSync(fd);
