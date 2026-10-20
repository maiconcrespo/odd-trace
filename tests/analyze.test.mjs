import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
	parseDoc,
	selectRuns,
	classifyOutcome,
	buildRows,
	coverage,
	attachReview,
	RUNNER_RE,
	PIPELINE_RE,
} from "../lib/analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixture");
const REPO = "/home/crespo/gentlemansystem/gentle-shell";

const fixtureDoc = () => parseDoc(readFileSync(join(FIXTURES, "feature.md"), "utf8"));

// Rebuild runs from a transcript file exactly as the CLI does.
function runsFrom(dir) {
	const text = readFileSync(dir, "utf8").trim().split("\n");
	const calls = new Map();
	const runs = [];
	let cwd = null;
	for (const line of text) {
		const j = JSON.parse(line);
		if (j.type === "session" && j.cwd) cwd = j.cwd;
		if (j.type !== "message" || !j.message) continue;
		const m = j.message;
		if (m.role === "assistant" && Array.isArray(m.content)) {
			for (const p of m.content) {
				if (p.type === "toolCall") calls.set(p.id, { command: String(p.arguments?.command ?? ""), ts: j.timestamp });
			}
		} else if (m.role === "toolResult" && calls.has(m.toolCallId)) {
			const c = calls.get(m.toolCallId);
			runs.push({
				command: c.command,
				ts: j.timestamp,
				isError: Boolean(m.isError),
				text: Array.isArray(m.content) ? m.content.map((p) => p.text ?? "").join("") : String(m.content ?? ""),
				cwd,
			});
		}
	}
	return runs;
}

// The commit the fixture references must exist in the repo for the join to run.
const commitFacts = new Map([
	[
		"6b8acd37f",
		{
			found: true,
			sha: "6b8acd37f0000000000000000000000000000abcd",
			date: "2026-10-15T14:41:17+02:00",
			testFiles: ["tests/autonomous-guard.test.ts"],
			files: ["tests/autonomous-guard.test.ts"],
		},
	],
]);

const joinFixture = (fixtureDir) =>
	buildRows({
		parsed: fixtureDoc(),
		commitFacts,
		runs: runsFrom(join(FIXTURES, fixtureDir, "--r--", "s.jsonl")),
		repoRoot: REPO,
	});

// ------------------------------------------------------------------ the join
test("positive control: a real runner run after the commit is observed evidence", () => {
	const rows = joinFixture("pos");
	assert.equal(rows.length, 2);
	for (const r of rows) {
		assert.equal(r.code, "0");
		assert.equal(r.verdict, "observed pass");
		assert.equal(r.check, "autonomous-guard.test.ts");
	}
	assert.deepEqual(coverage(rows), { covered: 2, total: 2 });
});

test("a pipeline's exit status is never evidence, even when it exits 0", () => {
	const rows = joinFixture("neg-pipeline");
	for (const r of rows) {
		assert.equal(r.code, "piped");
		assert.equal(r.verdict, "NOT EVIDENCE (pipeline)");
	}
	assert.deepEqual(coverage(rows), { covered: 0, total: 2 });
});

test("a failing run is reported as failing, never rounded up", () => {
	const rows = joinFixture("neg-fail");
	for (const r of rows) {
		assert.equal(r.code, "fail");
		assert.equal(r.verdict, "observed fail");
	}
	assert.deepEqual(coverage(rows), { covered: 0, total: 2 });
});

test("a run performed before the commit cannot speak about the commit", () => {
	const rows = joinFixture("neg-stale");
	for (const r of rows) {
		assert.equal(r.verdict, "STALE CHECK");
	}
	assert.deepEqual(coverage(rows), { covered: 0, total: 2 });
});

// ------------------------------------------------------- classification rules
test("a load error means the test never ran", () => {
	const o = classifyOutcome({
		command: "node --test tests/a.test.ts",
		text: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@earendil-works/pi-tui'",
	});
	assert.equal(o.code, "error");
});

test("unparsed output stays '?' instead of becoming a pass", () => {
	const o = classifyOutcome({ command: "node --test tests/a.test.ts", text: "something happened\n" });
	assert.equal(o.code, "?");
});

test("partial passes are not full passes", () => {
	const o = classifyOutcome({
		command: "node --test tests/a.test.ts",
		text: "ℹ tests 12\nℹ pass 10\nℹ fail 0\n",
	});
	assert.equal(o.code, "partial");
});

test("node --test's real summary shape is parsed", () => {
	const o = classifyOutcome({
		command: "node --test tests/a.test.ts",
		text: "✔ ok\nℹ tests 12\nℹ suites 3\nℹ pass 12\nℹ fail 0\nℹ cancelled 0",
	});
	assert.equal(o.code, "0");
});

// ------------------------------------------------------------- run selection
test("a filename mentioned by git diff is not a test run", () => {
	const runs = [
		{
			command: "cd repo && git diff --stat tests/autonomous-guard.test.ts",
			ts: "2026-10-16T10:00:00Z",
			cwd: REPO,
			text: "",
		},
	];
	assert.equal(selectRuns(runs, ["tests/autonomous-guard.test.ts"], REPO).length, 0);
});

test("a run in another checkout is rejected", () => {
	const runs = [
		{
			command: "node --test tests/autonomous-guard.test.ts",
			ts: "2026-10-16T10:00:00Z",
			cwd: "/home/other/worktree",
			text: "",
		},
	];
	assert.equal(selectRuns(runs, ["tests/autonomous-guard.test.ts"], REPO).length, 0);
});

test("runner detection covers the runners this project uses", () => {
	for (const c of [
		"node --experimental-strip-types --test tests/a.test.ts",
		"node --test tests/a.test.ts",
		"pnpm test",
		"npx vitest run x",
		"pytest -q",
		"python3 -m unittest discover",
		"go test ./...",
	]) {
		assert.ok(RUNNER_RE.test(c), `should detect: ${c}`);
	}
});

test("pipeline detection catches filters and redirections", () => {
	for (const c of ["x | grep y", "x | head -3", "x > out.txt", "x | tee f"]) {
		assert.ok(PIPELINE_RE.test(c), `should flag: ${c}`);
	}
	assert.ok(!PIPELINE_RE.test("node --test tests/a.test.ts"));
});

// --------------------------------------------------------------- doc parsing
test("Tasks table is parsed by header name, with four or five columns", () => {
	const four = parseDoc(`## Tasks

| ID | Specs | Route | Commit |
|----|-------|-------|--------|
| T1 | S1 | inline | abc1234 |
`);
	assert.equal(four.tasks.length, 1);
	assert.deepEqual(four.tasks[0].specIds, ["S1"]);
	assert.deepEqual(four.tasks[0].commits, ["abc1234"]);

	const five = parseDoc(`## Tasks

| ID | Specs | Route | Status | Commit |
|----|-------|-------|--------|--------|
| T2 | S6-S7 | delegated | done | 7ff415745 |
`);
	assert.equal(five.tasks.length, 1);
	assert.deepEqual(five.tasks[0].specIds, ["S6", "S7"]);
	assert.deepEqual(five.tasks[0].commits, ["7ff415745"]);
});

test("a spec that belongs to no task is reported, not silently dropped", () => {
	const parsed = parseDoc(`## Specs

- **S1** owned
- **S2** orphan

## Tasks

| ID | Specs | Route | Commit |
|----|-------|-------|--------|
| T1 | S1 | inline | abc1234 |
`);
	const rows = buildRows({
		parsed,
		commitFacts: new Map([["abc1234", { found: true, sha: "abc1234ff", date: "2026-10-15T00:00:00Z", testFiles: [] }]]),
		runs: [],
		repoRoot: REPO,
	});
	const orphan = rows.find((r) => r.spec === "S2");
	assert.equal(orphan.verdict, "NO TASK");
});

test("a commit absent from the clone is reported as missing", () => {
	const parsed = parseDoc(`## Specs

- **S1** x

## Tasks

| ID | Specs | Route | Commit |
|----|-------|-------|--------|
| T1 | S1 | inline | deadbee |
`);
	const rows = buildRows({ parsed, commitFacts: new Map(), runs: [], repoRoot: REPO });
	assert.equal(rows[0].verdict, "COMMIT MISSING");
});

// ----------------------------------------------------------- review mapping
test("review inventory never invents a lineage for a task", () => {
	const rows = [{ spec: "S1", task: "T1", commit: "abc1234", code: "0", verdict: "observed pass" }];
	const withMatch = attachReview(rows, { status: "clean", entries: [{ lineage_id: "lin-1234", commit: "abc1234ff" }] });
	assert.match(withMatch[0].review, /lineage lin-1234/);

	const noMatch = attachReview(rows, { status: "clean", entries: [{ lineage_id: "lin-9999", commit: "fffffff" }] });
	assert.equal(noMatch[0].review, "no match");

	const none = attachReview(rows, { status: "clean", entries: [] });
	assert.equal(none[0].review, "none recorded");

	const unavailable = attachReview(rows, { error: "boom" });
	assert.equal(unavailable[0].review, "unavailable");
});

// ------------------------------------------- real-world shapes from the corpus
// Every case below is copied from an actual document in
// gentle-shell/odd/tasks. The corpus is the specification.

test("spec ids appear with and without bold, bullets, tags and a leading hash", () => {
	const parsed = parseDoc(`## Specs

- **S1** bold, plain
- **S2 — Em dash title.** body
S3 — no bullet, no bold
- S4 (user, verbatim): "quote"
- S#5 hash inside the id
1. S6 ordered list
`);
	assert.deepEqual(
		parsed.specs.map((s) => s.id),
		["S1", "S2", "S3", "S4", "S5", "S6"],
	);
});

test("a spec id mentioned mid-sentence is not a definition", () => {
	const parsed = parseDoc(`## Specs

- **S1** the real one, which references S9 and S12 inline.
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1"]);
});

test("task rows parse as table, bullet and prose in one document", () => {
	const parsed = parseDoc(`## Tasks

| ID | Specs | Route | Commit |
|----|-------|-------|--------|
| T1 | S1-S2 | inline | \`250cec03\`\` |

- T2 [x] S3 — work. Route: inline. Commit: \`608d90da\`
- [x] **SN-3 — Scheduler** | S4/S5 | route: delegated | Commit LOCAL \`0229cb\`

T4 · S6,S7 · inline · **DONE** — prose row
`);
	assert.deepEqual(
		parsed.tasks.map((t) => t.id),
		["T1", "T2", "SN3", "T4"],
	);
	assert.deepEqual(parsed.tasks[0].specIds, ["S1", "S2"]);
	assert.deepEqual(parsed.tasks[1].specIds, ["S3"]);
	assert.deepEqual(parsed.tasks[2].specIds, ["S4", "S5"]);
	assert.deepEqual(parsed.tasks[3].specIds, ["S6", "S7"]);
	assert.deepEqual(parsed.tasks[0].commits, ["250cec03"]);
	assert.deepEqual(parsed.tasks[1].commits, ["608d90da"]);
});

test("a table whose id column is named Unit and holds phases is readable", () => {
	const parsed = parseDoc(`## Tasks

| Unit | Intent | Candidate paths | Acceptance |
|------|--------|-----------------|------------|
| **N0** | plan, committed \`9282b002\` | docs | ok |
| **N1a** | codec, committed \`b2bdee09\` | lib | ok |
`);
	assert.deepEqual(parsed.tasks.map((t) => t.id), ["N0", "N1a"]);
	assert.deepEqual(parsed.tasks[0].commits, ["9282b002"]);
});

test("a spec range expands, but an absurd range does not", () => {
	const parsed = parseDoc(`## Specs

- **S1** a

## Tasks

| ID | Specs | Commit |
|----|-------|--------|
| T1 | S1-S4 | abc1234 |
| T2 | S1-S900 | abc1234 |
`);
	assert.deepEqual(parsed.tasks[0].specIds, ["S1", "S2", "S3", "S4"]);
	assert.deepEqual(parsed.tasks[1].specIds, ["S1", "S900"]);
});

test("section detection tolerates a horizontal rule as the separator", () => {
	const parsed = parseDoc(`## Specs

- **S1** a

---

## Tasks

| ID | Specs | Commit |
|----|-------|--------|
| T1 | S1 | abc1234 |
`);
	assert.equal(parsed.specs.length, 1);
	assert.equal(parsed.tasks.length, 1);
});

test("a document with tasks but no commit reference says so instead of guessing", () => {
	const parsed = parseDoc(`## Specs

- **S1** a

## Tasks

- [x] T1 S1 did the thing, no hash anywhere
`);
	const rows = buildRows({ parsed, commitFacts: new Map(), runs: [], repoRoot: REPO });
	assert.equal(rows[0].verdict, "NO COMMIT IN DOC");
});
