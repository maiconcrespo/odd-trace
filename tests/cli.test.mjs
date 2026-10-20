// CLI-level tests. These spawn the real executable, because the guards they
// cover live in argument handling, not in the pure analysis core.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "trace.mjs");
const REPO = "/home/crespo/gentlemansystem/gentle-shell";

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
	const r = run([
		"--doc",
		join(HERE, "..", "fixture", "feature.md"),
		"--repo",
		REPO,
		"--sessions",
		join(HERE, "..", "fixture", "pos"),
	]);
	assert.equal(r.status, 0);
	assert.match(r.stdout, /observed pass/);
	assert.match(r.stdout, /2\/2 specs have an observed passing check/);
});

test("--json emits parsable JSON", () => {
	const r = run([
		"--doc",
		join(HERE, "..", "fixture", "feature.md"),
		"--repo",
		REPO,
		"--sessions",
		join(HERE, "..", "fixture", "pos"),
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
	run(["--doc", join(HERE, "..", "fixture", "feature.md"), "--repo", REPO, "--sessions", join(HERE, "..", "fixture", "pos")]);
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
