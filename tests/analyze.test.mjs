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
import { createFixtureRepo, commitFactsFor, writeTranscript, runsFrom, TEST_FILE } from "./fixture-repo.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "..", "fixture");
// A repository this test owns, created at run time. The suite must pass on a
// machine that has never seen the author's checkout.
const REPO_FIXTURE = createFixtureRepo();
process.on("exit", () => REPO_FIXTURE.cleanup());
const REPO = REPO_FIXTURE.root;
const SHORT = REPO_FIXTURE.short;

// The fixture document cites the commit this run created, not a commit from
// the author's machine.
const fixtureDoc = () =>
	parseDoc(readFileSync(join(FIXTURES, "feature.md"), "utf8").replaceAll("COMMIT_PLACEHOLDER", SHORT));

// Rebuild runs from a transcript file exactly as the CLI does.

const commitFacts = commitFactsFor(REPO_FIXTURE);

// Each control builds its own transcript, so the expected verdict depends on
// the transcript and not on anything installed on this machine.
const joinWith = (outcome) => {
	const transcript = writeTranscript(REPO_FIXTURE, outcome);
	process.on("exit", () => transcript.cleanup());
	return buildRows({
		parsed: fixtureDoc(),
		commitFacts,
		runs: runsFrom(transcript.dir),
		repoRoot: REPO,
	});
};

// ------------------------------------------------------------------ the join
test("positive control: a real runner run after the commit is observed evidence", () => {
	const rows = joinWith("pass");
	assert.equal(rows.length, 2);
	for (const r of rows) {
		assert.equal(r.code, "0");
		assert.equal(r.verdict, "observed pass");
		assert.equal(r.check, "widget.test.js");
	}
	assert.deepEqual(coverage(rows), { covered: 2, total: 2 });
});

test("a pipeline's exit status is never evidence, even when it exits 0", () => {
	const rows = joinWith("pipeline");
	for (const r of rows) {
		assert.equal(r.code, "piped");
		assert.equal(r.verdict, "NOT EVIDENCE (pipeline)");
	}
	assert.deepEqual(coverage(rows), { covered: 0, total: 2 });
});

test("a failing run is reported as failing, never rounded up", () => {
	const rows = joinWith("fail");
	for (const r of rows) {
		assert.equal(r.code, "fail");
		assert.equal(r.verdict, "observed fail");
	}
	assert.deepEqual(coverage(rows), { covered: 0, total: 2 });
});

test("a run performed before the commit cannot speak about the commit", () => {
	const rows = joinWith("stale");
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
			command: "cd repo && git diff --stat tests/widget.test.js",
			ts: "2026-10-16T10:00:00Z",
			cwd: REPO,
			text: "",
		},
	];
	assert.equal(selectRuns(runs, [TEST_FILE], REPO).length, 0);
});

test("a run in another checkout is rejected", () => {
	const runs = [
		{
			command: "node --test tests/widget.test.js",
			ts: "2026-10-16T10:00:00Z",
			cwd: "/home/other/worktree",
			text: "",
		},
	];
	assert.equal(selectRuns(runs, [TEST_FILE], REPO).length, 0);
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

test("pipeline detection catches pipes into filters, and only those", () => {
	for (const c of ["x | grep y", "x | head -3", "x | tee f", "x 2>&1 | tail -5"]) {
		assert.ok(PIPELINE_RE.test(c), `should flag: ${c}`);
	}
	// A redirect leaves the runner as the last command, so $? is still its status.
	for (const c of ["node --test tests/a.test.ts", "x > out.txt", "x > out.log 2>&1", "x 2>&1"]) {
		assert.ok(!PIPELINE_RE.test(c), `should not flag: ${c}`);
	}
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

// A "---" line does NOT end a section: only the next "## " heading does. An
// earlier version of this test (and its commit message) claimed otherwise and
// passed for the wrong reason, because the following "## Tasks" heading ended the
// section anyway. This version builds a case where only a real "---" cut could
// change the result, and pins what the parser actually does. No document in the
// measured corpus contains such a line, so the behaviour is documented, not
// extended.
test("a horizontal rule does not end a section; only the next heading does", () => {
	const parsed = parseDoc(`## Specs

- **S1** before the rule

---

- **S2** after the rule, still inside Specs

## Tasks

| ID | Specs | Commit |
|----|-------|--------|
| T1 | S1 | abc1234 |
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1", "S2"]);
	assert.equal(parsed.tasks.length, 1);
});

test("a horizontal rule between two sections does not disturb either of them", () => {
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

// ------------------------------------- requirements without S# ids (real repos)
test("## Acceptance criteria becomes numbered specs", () => {
	const parsed = parseDoc(`# Feature

## Acceptance criteria

1. \`tool transcribe <file>\` prints the transcript to stdout.
2. \`--clean\` removes filler words and reports every removal.
3. No system CUDA install required.

## Tasks

| ID | Task | Status |
| --- | --- | --- |
| T1 | Scaffold | done |
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1", "S2", "S3"]);
	assert.equal(parsed.specs[0].derived, true);
	assert.match(parsed.specs[0].text, /prints the transcript/);
});

test("## Specs wins over ## Acceptance criteria when both exist", () => {
	const parsed = parseDoc(`## Specs

- **S1** explicit id

## Acceptance criteria

1. numbered but secondary
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1"]);
	assert.equal(parsed.specs[0].derived, undefined);
});

test("## Status checkboxes become tasks when ## Tasks is absent", () => {
	const parsed = parseDoc(`# Project

## Status

- [x] 1. Scaffold Topcoat + SQLx
- [x] 2. Data model
- [ ] 3. Backup to Drive
`);
	assert.deepEqual(parsed.tasks.map((t) => t.id), ["T1", "T2", "T3"]);
	assert.equal(parsed.tasks[0].shape, "status");
	assert.equal(parsed.tasks[0].status, "done");
});

test("## Tasks wins over ## Status when both exist", () => {
	const parsed = parseDoc(`## Tasks

| ID | Specs | Commit |
|----|-------|--------|
| T1 | S1 | abc1234 |

## Status

- [x] 1. something else
`);
	assert.deepEqual(parsed.tasks.map((t) => t.id), ["T1"]);
	assert.equal(parsed.tasks[0].shape, "table");
});

// ------------------------------------------------ exit status honesty (audit)
// A redirect to a file does not change the runner's exit status. Only a pipe
// into a filter does. The first version treated both the same and discarded
// runs whose EXIT=n was captured explicitly and correctly.
test("a redirect to a file with an explicit EXIT=0 is an observed pass", () => {
	const o = classifyOutcome({
		command: 'pnpm vitest run a.test.tsx > /tmp/o.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/o.log',
		text: "EXIT=0\n Test Files  1 passed (1)\n      Tests  20 passed (20)\n",
	});
	assert.equal(o.code, "0");
});

test("a redirect to a file with an explicit EXIT=1 is an observed failure, not 'piped'", () => {
	const o = classifyOutcome({
		command: 'pnpm vitest run a.test.tsx > /tmp/o.log 2>&1; echo "EXIT=$?"; tail -5 /tmp/o.log',
		text: "EXIT=1\n Tests  3 failed | 17 passed (20)\n",
	});
	assert.equal(o.code, "1");
});

test("2>&1 alone is not a pipeline", () => {
	const o = classifyOutcome({
		command: "node --test tests/a.test.ts 2>&1",
		text: "# tests 12\n# pass 12\n# fail 0\n",
	});
	assert.equal(o.code, "0");
});

test("a pipe into a filter stays 'piped' even when EXIT= is echoed afterwards", () => {
	// $? after a pipe is the filter's status, so the echoed value proves nothing.
	const o = classifyOutcome({
		command: 'node --test a.test.ts 2>&1 | grep -m2 Error; echo "EXIT=$?"',
		text: "Error [ERR_MODULE_NOT_FOUND]\nEXIT=0\n",
	});
	assert.equal(o.code, "piped");
});

test("EXIT= with an equals sign is understood", () => {
	const o = classifyOutcome({ command: "node --test a.test.ts", text: "EXIT=2\n" });
	assert.equal(o.code, "2");
});

// ------------------------------------------- only plausible commits (audit)
const commitsOf = (line) => parseDoc(`## Tasks\n\n- T1 S1 ${line}\n`).tasks[0].commits;

test("a GitHub Actions run id is not a commit", () => {
	assert.deepEqual(commitsOf("diag runs 38092721527 and 38092811888, committed b9b181a6e"), ["b9b181a6e"]);
});

test("a native review lineage id is not a commit", () => {
	assert.deepEqual(
		commitsOf("C1 commit 2f716b37fab29c3793e12922290881585720872d. Native review-fb329d05ec2b9b39 approved"),
		["2f716b37fab29c3793e12922290881585720872d"],
	);
});

test("abbreviated shas of 7 to 12 characters and full 40-character shas are kept", () => {
	assert.deepEqual(commitsOf("a1b2c3d, 250cec03, b8b1ba1a3, 0123456789ab"), ["a1b2c3d", "250cec03", "b8b1ba1a3", "0123456789ab"]);
});

test("a short all-digit sha is still a sha", () => {
	assert.deepEqual(commitsOf("committed 1234567"), ["1234567"]);
});

// ------------------------------------- acceptance criteria as bullets (audit 3)
// 34 of the 37 documents in the corpus that write requirements under
// "## Acceptance criteria" use bullets or checkboxes, not "1." numbering. Only
// numbered lists were read, so the headline "documents with specs" understated.
test("bulleted acceptance criteria become numbered specs", () => {
	const parsed = parseDoc(`## Acceptance criteria

- The Dot stays above normal windows.
- The panel keeps keyboard focus.
- Nothing is written to disk.
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1", "S2", "S3"]);
	assert.equal(parsed.specs[0].derived, true);
	assert.match(parsed.specs[1].text, /keyboard focus/);
});

test("checkbox acceptance criteria are specs, checked or not", () => {
	const parsed = parseDoc(`## Acceptance criteria

- [x] first criterion
- [ ] second criterion
* third with an asterisk bullet
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1", "S2", "S3"]);
	assert.doesNotMatch(parsed.specs[0].text, /^\[/);
});

test("a wrapped continuation line is not a new criterion", () => {
	const parsed = parseDoc(`## Acceptance criteria

- first criterion that
  continues on the next line
- second criterion
`);
	assert.equal(parsed.specs.length, 2);
});

test("an indented sub-bullet is not a separate criterion", () => {
	const parsed = parseDoc(`## Acceptance criteria

- parent criterion
  - detail under it
  - another detail
- second parent
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1", "S2"]);
});

test("explicit S# ids in the same section are not renumbered", () => {
	const parsed = parseDoc(`## Acceptance criteria

- **S4** an id the author chose
- **S9** another
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S4", "S9"]);
	assert.equal(parsed.specs[0].derived, undefined);
});

// ------------------------------- id collisions inside one section (audit 4)
// A section can mix explicit ids with unnumbered items. Numbering the latter
// from 1 produced a second "S1" next to the author's "S1": two requirements
// answering to one id, which makes every join keyed on the id wrong.
test("an unnumbered item never takes an id the author already used", () => {
	const parsed = parseDoc(`## Acceptance criteria

- **S1** explicit one
- an item with no id
- another with no id
`);
	const ids = parsed.specs.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(",")}`);
	assert.equal(ids[0], "S1");
	assert.equal(parsed.specs[0].derived, undefined);
});

test("derived ids skip past explicit ones wherever the explicit ones appear", () => {
	const parsed = parseDoc(`## Acceptance criteria

- first with no id
- **S2** explicit, second position
- third with no id
`);
	const ids = parsed.specs.map((s) => s.id);
	assert.equal(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(",")}`);
	assert.deepEqual(
		parsed.specs.filter((s) => s.derived).map((s) => s.text),
		["first with no id", "third with no id"],
	);
});

test("a section with no explicit ids is still numbered from S1", () => {
	const parsed = parseDoc(`## Acceptance criteria

- one
- two
- three
`);
	assert.deepEqual(parsed.specs.map((s) => s.id), ["S1", "S2", "S3"]);
});

// ------------------------------------- Tasks headings with a suffix (audit 5)
// Nine documents in the measured corpus head the section "## Tasks and routes",
// "## Tasks and routing", "## Tasks and acceptance" or "## Tasks / acceptance".
// Only the exact heading was read, so all nine reported zero tasks while having
// task rows plainly visible, and the "documents with readable tasks" figure was
// low because of the parser, not the corpus.
test("a Tasks heading with a suffix is read as the task section", () => {
	for (const heading of ["Tasks and routes", "Tasks and routing", "Tasks and acceptance", "Tasks / acceptance"]) {
		const parsed = parseDoc(`## ${heading}

- [x] T1 (inline) — did the first thing
- [ ] T2 (delegated) — second thing
`);
		assert.deepEqual(parsed.tasks.map((t) => t.id), ["T1", "T2"], `heading: ${heading}`);
	}
});

test("the exact '## Tasks' heading still wins over a suffixed one", () => {
	const parsed = parseDoc(`## Tasks and routes

- [x] T9 from the suffixed section

## Tasks

| ID | Specs | Commit |
|----|-------|--------|
| T1 | S1 | abc1234 |
`);
	assert.deepEqual(parsed.tasks.map((t) => t.id), ["T1"]);
	assert.equal(parsed.tasks[0].shape, "table");
});

test("a suffixed Tasks heading wins over a Status checklist", () => {
	const parsed = parseDoc(`## Tasks and routes

- [x] T1 (inline) — real task

## Status

- [x] 1. something else
`);
	assert.deepEqual(parsed.tasks.map((t) => t.id), ["T1"]);
	assert.notEqual(parsed.tasks[0].shape, "status");
});

test("a heading that merely starts with the letters 'Tasks' is not a task section", () => {
	const parsed = parseDoc(`## Taskset notes

- [x] T1 (inline) — not under a Tasks heading
`);
	assert.deepEqual(parsed.tasks, []);
});

test("commits and specs are read from a suffixed Tasks section", () => {
	const parsed = parseDoc(`## Tasks and routes

- [x] T1 S1 (inline) — work. Commit: \`abc1234\`
`);
	assert.deepEqual(parsed.tasks[0].specIds, ["S1"]);
	assert.deepEqual(parsed.tasks[0].commits, ["abc1234"]);
});
