// Diagnostic: which feature documents still resist the parser, and why.
// Read-only. Prints the first spec-looking line of each document the parser
// finds no specs in, so the gap is visible instead of guessed.

import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSpecs, parseTasks } from "./lib/analyze.mjs";

const dir = resolve(process.argv[2] ?? ".");
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();

let hasSpecSection = 0;
let parsedSpecs = 0;
let parsedTasks = 0;
const failures = [];

for (const f of files) {
	const text = readFileSync(join(dir, f), "utf8");
	const specs = parseSpecs(text);
	const tasks = parseTasks(text);
	if (/^##\s+Specs\s*$/m.test(text)) hasSpecSection++;
	if (specs.length) parsedSpecs++;
	if (tasks.length) parsedTasks++;
	if (/^##\s+Specs\s*$/m.test(text) && !specs.length) {
		const body = text.split(/^##\s+Specs\s*$/m)[1]?.split(/^##\s/m)[0] ?? "";
		const first = body.split("\n").find((l) => /S\d/.test(l)) ?? "(no line mentions S#)";
		failures.push({ file: f, first: first.trim().slice(0, 90) });
	}
}

console.log(`documents              ${files.length}`);
console.log(`with a ## Specs section ${hasSpecSection}`);
console.log(`specs parsed           ${parsedSpecs}`);
console.log(`tasks parsed           ${parsedTasks}`);
console.log(`specs section but 0 specs parsed: ${failures.length}`);
for (const x of failures) console.log(`  ${x.file}\n      ${x.first}`);
