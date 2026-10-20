// Coverage report over a directory of ODD feature documents. Read-only.
//
// It answers one question: how many documents in this repository can the join
// actually read? A document with specs but no readable tasks contributes
// nothing, and that is a finding about the corpus, not about the parser.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDoc } from "./lib/analyze.mjs";

const [, , dirArg] = process.argv;
if (!dirArg) {
	console.error("usage: coverage-report.mjs <dir-of-feature-docs>");
	process.exit(2);
}
const dir = resolve(dirArg);
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();

let docs = 0;
let withSpecs = 0;
let withTasks = 0;
let joinable = 0;
let specsTotal = 0;
let tasksTotal = 0;
const shapes = new Map();
const orphans = [];
const missingLog = [];

for (const f of files) {
	const parsed = parseDoc(readFileSync(join(dir, f), "utf8"));
	docs++;
	if (parsed.specs.length) withSpecs++;
	if (parsed.tasks.length) withTasks++;
	if (parsed.specs.length && parsed.tasks.length) joinable++;
	specsTotal += parsed.specs.length;
	tasksTotal += parsed.tasks.length;
	for (const t of parsed.tasks) shapes.set(t.shape, (shapes.get(t.shape) ?? 0) + 1);

	if (parsed.specs.length && !parsed.tasks.length) {
		orphans.push({ file: f, specs: parsed.specs.length, sections: parsed.sections });
	}
	if (!parsed.sections.log) missingLog.push(f);
}

console.log(`directory            ${dir}`);
console.log(`documents            ${docs}`);
console.log(`with ## Specs (S#)   ${withSpecs}`);
console.log(`with readable tasks  ${withTasks}`);
console.log(`joinable (both)      ${joinable}`);
console.log(`specs parsed         ${specsTotal}`);
console.log(`tasks parsed         ${tasksTotal}`);
console.log();
console.log("task row shapes");
for (const [shape, n] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`  ${shape.padEnd(8)} ${n}`);

if (orphans.length) {
	console.log(`\nspecs but no readable task rows (${orphans.length})`);
	for (const o of orphans.slice(0, 15)) console.log(`  ${o.file}  specs=${o.specs} sections=${JSON.stringify(o.sections)}`);
	if (orphans.length > 15) console.log(`  ... ${orphans.length - 15} more`);
}

console.log(`\ndocuments without a ## Log section: ${missingLog.length}/${docs}`);
