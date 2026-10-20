// Diagnostic: which feature documents still resist the parser, and why.
// Read-only. For each document the parser cannot read, it prints the file, the
// reason (no requirement section it can read, a section that yields nothing, no
// task section), and the level-2 headings it found, so the gap is visible
// instead of guessed.

import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSpecs, parseTasks } from "./lib/analyze.mjs";

const dir = resolve(process.argv[2] ?? ".");
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
	console.error(`feature-docs directory not found: ${dir}`);
	console.error("  this project may have no odd/tasks directory at all");
	process.exit(2);
}
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();

const heads = (text) => [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1]);

let hasSpecSection = 0;
let parsedSpecs = 0;
let parsedTasks = 0;
const resist = [];

for (const f of files) {
	const text = readFileSync(join(dir, f), "utf8");
	const specs = parseSpecs(text);
	const tasks = parseTasks(text);
	const hasSpecsHeading = /^##\s+Specs\s*$/m.test(text);
	const hasTasksHeading = /^##\s+Tasks(?=[\s/])/m.test(text);
	if (hasSpecsHeading) hasSpecSection++;
	if (specs.length) parsedSpecs++;
	if (tasks.length) parsedTasks++;

	// A document that yields both is joined. Anything less is reported: the
	// interesting failures are not only an empty Specs section but a Tasks
	// section whose rows carry ids the parser does not recognise, and documents
	// with neither shape at all.
	if (specs.length && tasks.length) continue;

	const reasons = [];
	if (!specs.length) {
		if (hasSpecsHeading) {
			const body = text.split(/^##\s+Specs\s*$/m)[1]?.split(/^##\s/m)[0] ?? "";
			const first = body.split("\n").find((l) => /S\d/.test(l)) ?? "(no line mentions S#)";
			reasons.push(`## Specs yields no spec, first spec-looking line: ${first.trim().slice(0, 80)}`);
		} else {
			reasons.push("no requirement section it can read (## Specs or ## Acceptance criteria)");
		}
	}
	if (!tasks.length) {
		reasons.push(hasTasksHeading ? "## Tasks yields no task" : "no ## Tasks section");
	}
	resist.push({ file: f, reasons, heads: heads(text).slice(0, 8).join(" / ") || "(no level-2 heading)" });
}

console.log(`documents               ${files.length}`);
console.log(`with a ## Specs section  ${hasSpecSection}`);
console.log(`specs parsed            ${parsedSpecs}`);
console.log(`tasks parsed            ${parsedTasks}`);
if (!resist.length) {
	console.log("nothing to investigate: every document yielded specs and tasks");
} else {
	console.log(`documents the join cannot use: ${resist.length}`);
	for (const r of resist) {
		console.log(`  ${r.file}`);
		for (const reason of r.reasons) console.log(`      ${reason}`);
		console.log(`      headings: ${r.heads}`);
	}
}
