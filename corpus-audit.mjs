// Corpus audit: for every feature document in a repository, how much of the
// evidence chain is actually resolvable here?
//
// Read-only. It never writes and never touches git state beyond reads.
//
// The interesting number is not "how many documents parse" but "how many
// documents can the join follow to a commit that exists in this clone".

import { execFileSync } from "node:child_process";
import { existsSync, statSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseDoc } from "./lib/analyze.mjs";

const [, , dirArg, repoArg] = process.argv;
if (!dirArg) {
	console.error("usage: corpus-audit.mjs <dir-of-feature-docs> [repo]");
	process.exit(2);
}
const dir = resolve(dirArg);
const repo = resolve(repoArg ?? ".");

const git = (...a) => {
	try {
		return execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
};

const exists = (c) => git("cat-file", "-e", `${c}^{commit}`) !== null;

if (!existsSync(dir) || !statSync(dir).isDirectory()) {
	console.error(`feature-docs directory not found: ${dir}`);
	console.error("  this project may have no odd/tasks directory at all");
	process.exit(2);
}
const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
const totals = {
	docs: files.length,
	withSpecs: 0,
	withTasks: 0,
	joinable: 0,
	specs: 0,
	tasks: 0,
	commitsReferenced: 0,
	commitsPresent: 0,
	commitsMissing: 0,
	docsWithAllCommitsPresent: 0,
	docsWithAnyCommitMissing: 0,
	docsWithoutCommitColumn: 0,
};
const missingByDoc = [];
const distinctRefs = new Set();
const distinctMissing = new Set();

for (const f of files) {
	const parsed = parseDoc(readFileSync(join(dir, f), "utf8"));
	if (parsed.specs.length) totals.withSpecs++;
	if (parsed.tasks.length) totals.withTasks++;
	if (parsed.specs.length && parsed.tasks.length) totals.joinable++;
	totals.specs += parsed.specs.length;
	totals.tasks += parsed.tasks.length;

	const refs = [...new Set(parsed.tasks.flatMap((t) => t.commits))];
	if (!refs.length) {
		if (parsed.tasks.length) totals.docsWithoutCommitColumn++;
		continue;
	}
	let present = 0;
	const missing = [];
	for (const c of refs) {
		totals.commitsReferenced++;
		distinctRefs.add(c);
		if (!exists(c)) distinctMissing.add(c);
		if (exists(c)) {
			present++;
			totals.commitsPresent++;
		} else {
			missing.push(c);
			totals.commitsMissing++;
		}
	}
	if (present === refs.length) totals.docsWithAllCommitsPresent++;
	if (missing.length) {
		totals.docsWithAnyCommitMissing++;
		missingByDoc.push({ file: f, present, missing });
	}
}

console.log(`documents                  ${totals.docs}`);
console.log(`with ## Specs (S#)         ${totals.withSpecs}`);
console.log(`with readable task rows    ${totals.withTasks}`);
console.log(`joinable (specs and tasks) ${totals.joinable}`);
console.log(`specs parsed               ${totals.specs}`);
console.log(`tasks parsed               ${totals.tasks}`);
console.log();
// Two units, named explicitly: a commit cited by two documents is two references
// but one commit. Reporting only one of them without saying which was ambiguous.
console.log(`commit references (per document)  ${totals.commitsReferenced}`);
console.log(`  present in this clone    ${totals.commitsPresent}`);
console.log(`  missing from this clone  ${totals.commitsMissing}`);
console.log(`distinct commits                  ${distinctRefs.size}`);
console.log(`  missing from this clone  ${distinctMissing.size}`);
console.log(`documents whose commits all resolve      ${totals.docsWithAllCommitsPresent}`);
console.log(`documents with at least one missing      ${totals.docsWithAnyCommitMissing}`);
console.log(`documents with tasks but no commit ref   ${totals.docsWithoutCommitColumn}`);

if (missingByDoc.length) {
	console.log(`\ndocuments whose referenced commits do not exist here (${missingByDoc.length})`);
	for (const d of missingByDoc.slice(0, 20)) {
		console.log(`  ${d.file}  present=${d.present} missing=${d.missing.slice(0, 3).join(",")}${d.missing.length > 3 ? "…" : ""}`);
	}
	if (missingByDoc.length > 20) console.log(`  ... ${missingByDoc.length - 20} more`);
}
