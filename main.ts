// Grading driver for the markdown-render-speed-02 entry (revision r4).
//
// The harness executes `node main.ts`. The driver loads every case
// from cases.json inside the input directory (an array of objects
// with "id" and "markdown" fields), renders each case independently
// through parse() from ./parse.js, and writes the resulting HTML
// strings — in the same order as the cases — as a JSON array to
// html.json inside the output directory. When running outside the
// grading container, MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand
// in for the conventional /input and /output locations.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from './parse.js';

const inputDirectory = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDirectory = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const casesJson = readFileSync(join(inputDirectory, 'cases.json'), 'utf8');
const cases = JSON.parse(casesJson) as { id: string; markdown: string }[];

const rendered: string[] = [];
for (const testCase of cases) {
  rendered.push(parse(testCase.markdown));
}

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, 'html.json'), JSON.stringify(rendered));
