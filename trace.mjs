#!/usr/bin/env node
// gentle-trace prototype — READ ONLY.
//
// Joins what already exists and is currently only joined by hand:
//   S# (spec)  ->  T# (task) -> commit -> observed check run -> review authority
//
// Sources (all read-only, nothing written anywhere):
//   - the ODD feature document (`## Specs`, `## Tasks`, `## Log`)
//   - git (commit existence / date / changed test files)
//   - Pi session transcripts (bash tool call + toolResult pairing)
//   - `gentle-ai review status` (read-only inventory, optional)
//
// It never emits a verdict, never writes, never approves. It reports what was
// observed and where the chain is missing.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
	const i = args.indexOf(`--${name}`);
	return i === -1 ? dflt : args[i + 1];
};

const docPath = opt("doc");
if (!docPath) {
	console.error("usage: trace.mjs --doc <feature.md> [--repo <dir>] [--sessions <dir>] [--gentle-ai <bin>]");
	process.exit(2);
}
const repo = opt("repo", process.cwd());
const sessionsRoot = opt("sessions", join(process.env.HOME ?? "", ".gentle-shell/agent/sessions"));
const gentleAi = opt("gentle-ai", null);

const read = (p) => readFileSync(p, "utf8");
const git = (...a) => {
	try {
		return execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
};

// ---------------------------------------------------------------- parse spec
const doc = read(docPath);
const section = (name) => {
	const re = new RegExp(`^## ${name}\\s*$`, "m");
	const m = re.exec(doc);
	if (!m) return "";
	const rest = doc.slice(m.index + m[0].length);
	const next = /^## /m.exec(rest);
	return next ? rest.slice(0, next.index) : rest;
};

const specs = [];
for (const line of section("Specs").split("\n")) {
	const m = /^\s*[-*]\s*\*\*(S\d+)\*\*\s*(.*)$/.exec(line);
	if (m) specs.push({ id: m[1], text: m[2].trim() });
}

const tasks = [];
let taskCols = null;
for (const line of section("Tasks").split("\n")) {
	if (!line.trim().startsWith("|")) continue;
	const raw = line.split("|").slice(1, -1).map((c) => c.trim());
	if (raw.every((c) => /^:?-+:?$/.test(c))) continue;
	// Map by header name, never by assumed arity: feature documents use four or
	// five columns depending on whether a Status column exists.
	if (!taskCols) {
		const lower = raw.map((c) => c.toLowerCase());
		if (lower.includes("id")) {
			taskCols = {
				id: lower.indexOf("id"),
				specs: lower.findIndex((c) => /spec/.test(c)),
				route: lower.indexOf("route"),
				status: lower.indexOf("status"),
				commit: lower.indexOf("commit"),
			};
			continue;
		}
	}
	if (!taskCols) continue;
	const at = (i) => (i >= 0 ? (raw[i] ?? "") : "");
	tasks.push({
		id: at(taskCols.id),
		specIds: (at(taskCols.specs).match(/S\d+/g) ?? []),
		route: at(taskCols.route),
		status: at(taskCols.status),
		commits: (at(taskCols.commit).match(/\b[0-9a-f]{7,40}\b/g) ?? []),
	});
}

const risk = /^Risk:\s*(.+)$/m.exec(doc)?.[1]?.trim() ?? null;
const logs = [];
for (const line of section("Log").split("\n")) {
	const m = /^\s*[-*]\s*\*\*(L\d+)\*\*\s*(.*)$/.exec(line);
	if (m) logs.push({ id: m[1], text: m[2].trim() });
}

// ------------------------------------------------------------ commit evidence
const commitFacts = new Map();
for (const t of tasks) {
	for (const c of t.commits) {
		if (commitFacts.has(c)) continue;
		const sha = git("rev-parse", "--verify", `${c}^{commit}`);
		if (!sha) {
			commitFacts.set(c, { found: false });
			continue;
		}
		const meta = git("log", "-1", "--format=%H%x1f%ad%x1f%s", "--date=short", sha);
		const [full, date, subject] = (meta ?? "").split("\u001f");
		const files = (git("show", "--name-only", "--format=", sha) ?? "").split("\n").filter(Boolean);
		commitFacts.set(c, {
			found: true,
			sha: full ?? sha,
			date,
			subject,
			testFiles: files.filter((f) => /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\./.test(f)),
			files,
		});
	}
}

// ------------------------------------------------------- observed check runs
// A check run is a bash toolCall paired with its toolResult. We only keep runs
// whose command mentions a test file changed by one of the feature's commits,
// and we keep the observed outcome verbatim (never inferred).
function collectRuns(dir) {
	const runs = [];
	let files = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return runs;
	}
	for (const f of files) {
		const full = join(dir, f);
		let lines;
		try {
			lines = read(full).trim().split("\n");
		} catch {
			continue;
		}
		const calls = new Map();
		// Track the working directory the transcript declares, so a run executed in
		// another worktree is never attributed to this repository.
		let cwd = null;
		for (const line of lines) {
			let j;
			try {
				j = JSON.parse(line);
			} catch {
				continue;
			}
			if (j.type === "session" && j.cwd) cwd = j.cwd;
			if (j.type !== "message" || !j.message) continue;
			const m = j.message;
			if (m.role === "assistant" && Array.isArray(m.content)) {
				for (const p of m.content) {
					if (p.type === "toolCall" && (p.name === "bash" || p.name === "Bash")) {
						calls.set(p.id, { command: String(p.arguments?.command ?? ""), file: f, ts: j.timestamp });
					}
				}
			} else if (m.role === "toolResult" && calls.has(m.toolCallId)) {
				const call = calls.get(m.toolCallId);
				const text = Array.isArray(m.content)
					? m.content.map((p) => p.text ?? "").join("")
					: String(m.content ?? "");
				runs.push({
					command: call.command,
					file: call.file,
					ts: j.timestamp ?? call.ts,
					isError: Boolean(m.isError),
					durationMs: m.durationMs ?? null,
					text,
					cwd,
				});
			}
		}
	}
	return runs;
}

const runs = [];
if (existsSync(sessionsRoot)) {
	for (const entry of readdirSync(sessionsRoot)) {
		const d = join(sessionsRoot, entry);
		try {
			if (!statSync(d).isDirectory()) continue;
		} catch {
			continue;
		}
		runs.push(...collectRuns(d).map((r) => ({ ...r, project: entry })));
	}
}

// Precision matters more than recall here: a file name that merely appears in a
// `git diff`/`git show`/`grep` command is not a check. A run only counts when a
// test file changed by the commit is the argument of a test runner invocation.
const RUNNER_RE = /(^|[\s;&|(])(node\s+--experimental-strip-types\s+--test|node\s+--test|pnpm\s+(test|vitest)|npx\s+vitest|vitest|jest|pytest|python3?\s+-m\s+(unittest|pytest)|go\s+test)\b/;

const relevantRuns = (testFiles, commitCwd) => {
	if (!testFiles.length) return [];
	const base = testFiles.map((f) => basename(f));
	return runs.filter((r) => {
		if (!RUNNER_RE.test(r.command)) return false;
		if (!base.some((b) => r.command.includes(b))) return false;
		// A run inside another worktree answers a different checkout.
		if (commitCwd && r.cwd && r.cwd !== commitCwd) return false;
		return true;
	});
};

// A shell pipeline's exit status is the LAST command's status, not the test's.
// `node --test x.test.ts | grep -m2 Error` exits 0 when grep matches, even
// though the tests failed. Any run piped or redirected through a filter is
// therefore not evidence of a passing suite.
const PIPELINE_RE = /\|\s*(grep|head|tail|tee|awk|sed|cat|wc)\b|>\s*\S+/;

// Accept the runner's own two report shapes: `ℹ pass 12` (node --test TAP-ish)
// and `# pass 12` (TAP). A bare `?` is a real answer — it means "a runner ran,
// but this transcript does not prove the outcome" — and is never rounded up to a pass.
const clean = (t) => t.replace(/[\u2139\u2714\u2716\u2718]/g, " ");

function outcome(run) {
	const t = clean(run.text);
	const tail = t.trim().split("\n").slice(-3).join(" ⏎ ");
	const piped = PIPELINE_RE.test(run.command);
	if (piped) return { code: "piped", tail, note: "exit status belongs to the filter, not the test" };
	if (/exit code|EXIT:|exited with/i.test(run.text)) {
		const m = /(?:exit code|EXIT:?)\s*(\d+)/i.exec(run.text);
		if (m) return { code: m[1], tail };
	}
	if (/ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find (package|module)/.test(run.text)) {
		return { code: "error", tail, note: "runner could not load, so the test never ran" };
	}
	const fail = /[#\s]fail\s+(\d+)/i.exec(t);
	const pass = /[#\s]pass\s+(\d+)/i.exec(t);
	const tests = /[#\s]tests\s+(\d+)/i.exec(t);
	if (fail && fail[1] !== "0") return { code: "fail", tail, note: `${fail[1]} failing` };
	if (pass && pass[1] !== "0") {
		if (tests && tests[1] !== pass[1]) return { code: "partial", tail, note: `${pass[1]}/${tests[1]} passed` };
		return { code: "0", tail };
	}
	return { code: run.isError ? "err" : "?", tail };
}

// ------------------------------------------------------------------- reports
const rows = [];
for (const s of specs) {
	const owning = tasks.filter((t) => t.specIds.includes(s.id));
	if (!owning.length) {
		rows.push({ spec: s.id, task: "—", commit: "—", check: "—", code: "—", verdict: "NO TASK" });
		continue;
	}
	for (const t of owning) {
		if (!t.commits.length) {
			rows.push({ spec: s.id, task: t.id, commit: "—", check: "—", code: "—", verdict: "NO COMMIT" });
			continue;
		}
		for (const c of t.commits) {
			const fact = commitFacts.get(c);
			if (!fact?.found) {
				rows.push({ spec: s.id, task: t.id, commit: c, check: "—", code: "—", verdict: "COMMIT MISSING" });
				continue;
			}
			const observed = relevantRuns(fact.testFiles, repo).sort((a, b) => String(b.ts).localeCompare(String(a.ts)));
			if (!observed.length) {
				rows.push({
					spec: s.id,
					task: t.id,
					commit: fact.sha.slice(0, 7),
					check: fact.testFiles.length ? `${fact.testFiles.length} file(s), no run found` : "no test file",
					code: "—",
					verdict: "NO CHECK OBSERVED",
				});
				continue;
			}
			// Only a run performed after the commit can speak about the commit.
			const commitDay = new Date(fact.date).getTime();
			const after = observed.filter((r) => {
				const ts = Date.parse(String(r.ts));
				return Number.isFinite(ts) && Number.isFinite(commitDay) && ts >= commitDay;
			});
			if (!after.length) {
				rows.push({
					spec: s.id,
					task: t.id,
					commit: fact.sha.slice(0, 7),
					check: `${observed.length} run(s) predate the commit`,
					code: "—",
					verdict: "STALE CHECK",
				});
				continue;
			}
			const run = after[0];
			const o = outcome(run);
			const checkName = basename(run.command.split(/\s+/).find((w) => /\.(test|spec)\./.test(w)) ?? "bash");
			rows.push({
				spec: s.id,
				task: t.id,
				commit: fact.sha.slice(0, 7),
				check: checkName,
				code: o.code,
				verdict:
					o.code === "0"
						? "observed pass"
						: o.code === "piped"
							? "NOT EVIDENCE (pipeline)"
							: o.code === "error"
								? "NOT EVIDENCE (load error)"
								: o.code === "?"
									? "runner ran, outcome not in log"
									: `observed ${o.code}`,
				tail: o.tail,
				runAt: run.ts,
			});
		}
	}
}

// review authority (read-only inventory; repo-scoped, not per task)
let review = null;
if (gentleAi && existsSync(gentleAi)) {
	try {
		const out = execFileSync(gentleAi, ["review", "status", "--cwd", repo], { encoding: "utf8" });
		const j = JSON.parse(out);
		review = { status: j.status, entries: (j.entries ?? []).length, authoritative: j.authoritative };
	} catch (e) {
		review = { error: String(e.message).split("\n")[0] };
	}
}

const pad = (s, n) => String(s).padEnd(n);
const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

console.log(`\nfeature  ${docPath}`);
console.log(`repo     ${repo}`);
console.log(`specs ${specs.length}   tasks ${tasks.length}   log entries ${logs.length}   risk ${risk ?? "(none)"}`);
console.log();
console.log(
	`${pad("S#", 5)}${pad("T#", 5)}${pad("commit", 9)}${pad("check", 34)}${pad("code", 6)}verdict`,
);
console.log("-".repeat(96));
for (const r of rows) {
	console.log(`${pad(r.spec, 5)}${pad(r.task, 5)}${pad(r.commit, 9)}${pad(trunc(r.check, 33), 34)}${pad(r.code, 6)}${r.verdict}`);
}

console.log("\nspec coverage");
const bySpec = new Map();
for (const r of rows) {
	const prev = bySpec.get(r.spec) ?? false;
	bySpec.set(r.spec, prev || r.verdict === "observed pass");
}
const covered = [...bySpec.values()].filter(Boolean).length;
console.log(`  ${covered}/${bySpec.size} specs have an observed passing check`);

if (review) {
	console.log("\nreview authority (read-only)");
	console.log(`  ${review.error ? `unavailable: ${review.error}` : `status=${review.status} entries=${review.entries} authoritative=${review.authoritative}`}`);
	console.log("  note: repo-scoped inventory; it does not map to a task or an S#.");
}
