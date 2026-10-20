// CLI-level tests. These spawn the real executable, because the guards they
// cover live in argument handling, not in the pure analysis core.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createFixtureRepo, writeTranscript } from "./fixture-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "trace.mjs");
// Built at run time: the suite must not depend on the author's checkout.
const FIXTURE = createFixtureRepo();
process.on("exit", () => FIXTURE.cleanup());
const REPO = FIXTURE.root;

// The checked-in fixture cites COMMIT_PLACEHOLDER; a temp copy binds it to the
// commit this run actually created.
function materializeDoc() {
	const dir = mkdtempSync(join(tmpdir(), "trace-doc-"));
	const src = readFileSync(join(HERE, "..", "fixture", "feature.md"), "utf8");
	const out = join(dir, "feature.md");
	writeFileSync(out, src.replaceAll("COMMIT_PLACEHOLDER", FIXTURE.short));
	process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
	return out;
}

const run = (args) =>
	spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });

test("a missing feature document fails loudly with exit 2", () => {
	const r = run(["--doc", "/nonexistent/nope.md", "--repo", REPO]);
	assert.equal(r.status, 2);
	assert.match(r.stderr, /feature document not found/);
	assert.equal(r.stdout, "");
});

test("a --repo that is not a git repository fails instead of printing an empty table", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-nogit-"));
	try {
		const doc = join(dir, "feature.md");
		writeFileSync(doc, "## Specs\n\n- **S1** x\n");
		const r = run(["--doc", doc, "--repo", dir]);
		assert.equal(r.status, 2);
		assert.match(r.stderr, /not a git repository/);
		assert.doesNotMatch(r.stdout, /observed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a document with no parsable sections warns and exits 3", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-empty-"));
	try {
		const doc = join(dir, "feature.md");
		writeFileSync(doc, "# just a title\n\nSome prose with no sections.\n");
		const r = run(["--doc", doc, "--repo", REPO]);
		assert.equal(r.status, 3);
		assert.match(r.stderr, /no specs and no tasks parsed/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a readable document prints the table and exits 0", () => {
	const transcript = writeTranscript(FIXTURE, "pass");
	process.on("exit", () => transcript.cleanup());
	const r = run([
		"--doc",
		materializeDoc(),
		"--repo",
		REPO,
		"--sessions",
		transcript.dir,
	]);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /observed pass/);
	assert.match(r.stdout, /2\/2 specs have an observed passing check/);
});

test("--json emits parsable JSON", () => {
	const transcript = writeTranscript(FIXTURE, "pass");
	process.on("exit", () => transcript.cleanup());
	const r = run([
		"--doc",
		materializeDoc(),
		"--repo",
		REPO,
		"--sessions",
		transcript.dir,
		"--json",
	]);
	assert.equal(r.status, 0);
	const parsed = JSON.parse(r.stdout);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].parsed.specs.length, 2);
	assert.equal(parsed[0].rows.length, 2);
});

test("the CLI writes nothing", () => {
	const before = spawnSync("git", ["-C", HERE, "status", "--porcelain", ".."], { encoding: "utf8" }).stdout;
	run(["--doc", materializeDoc(), "--repo", REPO, "--sessions", writeTranscript(FIXTURE, "pass").dir]);
	const after = spawnSync("git", ["-C", HERE, "status", "--porcelain", ".."], { encoding: "utf8" }).stdout;
	assert.equal(after, before);
});

test("a document with tasks but no specs lists the tasks instead of an empty table", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-nospecs-"));
	try {
		const doc = join(dir, "feature.md");
		writeFileSync(
			doc,
			`# Feature: x

## Tasks

- [x] **T1 — Scaffold.** did it
- [x] **T2 — Build.** did it

## Log
`,
		);
		const r = run(["--doc", doc, "--repo", REPO]);
		assert.equal(r.status, 0);
		assert.match(r.stdout, /no ## Specs section: 2 task\(s\) parsed/);
		assert.match(r.stdout, /T1/);
		assert.doesNotMatch(r.stdout, /S#/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an audit on a directory that does not exist fails with exit 2", () => {
	const r = spawnSync(process.execPath, [join(HERE, "..", "corpus-audit.mjs"), "/nonexistent/odd/tasks", REPO], {
		encoding: "utf8",
	});
	assert.equal(r.status, 2);
	assert.match(r.stderr, /directory not found/);
});

// ------------------------------------------------ audit units (second audit)
// A commit cited by two documents is two references but one commit. The audit
// once printed a single number without saying which unit it counted, and the
// published figures drifted by one between two measurements of the same corpus.
test("the audit reports references per document and distinct commits separately", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-units-"));
	try {
		const doc = (name) =>
			writeFileSync(
				join(dir, name),
				`## Specs\n\n- **S1** x\n\n## Tasks\n\n| ID | Specs | Commit |\n|----|-------|--------|\n| T1 | S1 | ${FIXTURE.short} |\n`,
			);
		doc("a.md");
		doc("b.md");
		const r = spawnSync(process.execPath, [join(HERE, "..", "corpus-audit.mjs"), dir, REPO], { encoding: "utf8" });
		assert.equal(r.status, 0);
		assert.match(r.stdout, /commit references \(per document\)\s+2/);
		assert.match(r.stdout, /distinct commits\s+1/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("an unresolvable commit is counted once as a distinct commit however many documents cite it", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-units-missing-"));
	try {
		const doc = (name) =>
			writeFileSync(
				join(dir, name),
				`## Specs\n\n- **S1** x\n\n## Tasks\n\n| ID | Specs | Commit |\n|----|-------|--------|\n| T1 | S1 | deadbee1 |\n`,
			);
		doc("a.md");
		doc("b.md");
		const r = spawnSync(process.execPath, [join(HERE, "..", "corpus-audit.mjs"), dir, REPO], { encoding: "utf8" });
		assert.equal(r.status, 0);
		const missing = [...r.stdout.matchAll(/missing from this clone\s+(\d+)/g)].map((m) => Number(m[1]));
		assert.deepEqual(missing, [2, 1]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

// ------------------------------------- authored vs derived specs (audit 3)
// "with ## Specs (S#)" printed 83 when only 46 documents have that heading: the
// other 37 write requirements under "## Acceptance criteria" and the parser
// numbers them. A label must say what it counts.
test("the audit separates authored specs from derived ones", () => {
	const dir = mkdtempSync(join(tmpdir(), "trace-derived-"));
	try {
		writeFileSync(join(dir, "authored.md"), "## Specs\n\n- **S1** a\n- **S2** b\n");
		writeFileSync(join(dir, "derived.md"), "## Acceptance criteria\n\n- first\n- second\n- third\n");
		writeFileSync(join(dir, "none.md"), "# nothing here\n");
		const r = spawnSync(process.execPath, [join(HERE, "..", "corpus-audit.mjs"), dir, REPO], { encoding: "utf8" });
		assert.equal(r.status, 0);
		assert.match(r.stdout, /documents with any parsed spec\s+2/);
		assert.match(r.stdout, /specs written by the author\s+2/);
		assert.match(r.stdout, /specs derived from a list\s+3/);
		assert.doesNotMatch(r.stdout, /with ## Specs/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
