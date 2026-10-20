#!/usr/bin/env node
// odd-trace — READ ONLY.
//
// Joins what already exists and is currently joined only by hand:
//   S# (spec) -> T# (task) -> commit -> observed check run -> review authority
//
// Nothing is written anywhere. No verdict is emitted, nothing is approved, and
// the native reviewer is never replaced. Every refusal to infer is deliberate;
// see README.md.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseDoc, buildRows, attachReview, coverage } from "./lib/analyze.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

// ------------------------------------------------------------------- options
function parseArgs(argv) {
	const out = { docs: [], sessions: [], repos: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		if (a === "--doc") out.docs.push(next());
		else if (a === "--sessions") out.sessions.push(...String(next()).split(",").filter(Boolean));
		else if (a === "--repo") out.repos.push(next());
		else if (a === "--gentle-ai") out.gentleAi = next();
		else if (a === "--json") out.json = true;
		else if (a === "-h" || a === "--help") out.help = true;
		else if (!a.startsWith("-")) out.docs.push(a);
	}
	return out;
}

const opt = parseArgs(process.argv.slice(2));

if (opt.help || !opt.docs.length) {
	console.error(`usage: trace.mjs --doc <feature.md> [--doc ...]
       [--repo <dir>] [--sessions <dir>[,<dir>...]] [--gentle-ai <bin>] [--json]

--sessions may be repeated, or list several roots separated by commas. Pass
every Pi home you work in: a run executed in a worktree with another HOME is
real evidence, but it lives in that HOME's transcript directory.`);
	process.exit(opt.help ? 0 : 2);
}

const repo = resolve(opt.repos[0] ?? process.cwd());
const sessionRoots =
	opt.sessions.length > 0
		? opt.sessions.map((p) => resolve(p))
		: [join(process.env.HOME ?? "", ".gentle-shell/agent/sessions")].filter((p) => existsSync(p));

const read = (p) => readFileSync(p, "utf8");
const git = (...a) => {
	try {
		return execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
};

// ------------------------------------------------------------------- guards
// Fail loud and early. A missing document or a non-repository must never
// produce an empty table that looks like a clean answer.
function fail(message, hint) {
	console.error(`odd-trace: ${message}`);
	if (hint) console.error(`  ${hint}`);
	process.exit(2);
}

if (!existsSync(repo) || !statSync(repo).isDirectory()) {
	fail(`--repo is not a directory: ${repo}`, "pass --repo <path-to-repository>");
}
if (git("rev-parse", "--git-dir") === null) {
	fail(`--repo is not a git repository: ${repo}`, "run from inside the repository, or pass --repo <path>");
}
for (const docPath of opt.docs) {
	if (!existsSync(docPath)) {
		fail(`feature document not found: ${docPath}`, "pass the path to an ODD feature document (odd/tasks/<name>.md)");
	}
	if (!statSync(docPath).isFile()) {
		fail(`--doc is not a file: ${docPath}`, "pass a single feature document, not a directory");
	}
}


// --------------------------------------------------------------- transcripts
function collectRuns(dir) {
	const runs = [];
	let files = [];
	try {
		files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
	} catch {
		return runs;
	}
	for (const f of files) {
		let lines;
		try {
			lines = read(join(dir, f)).trim().split("\n");
		} catch {
			continue;
		}
		const calls = new Map();
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
						calls.set(p.id, { command: String(p.arguments?.command ?? ""), ts: j.timestamp });
					}
				}
			} else if (m.role === "toolResult" && calls.has(m.toolCallId)) {
				const call = calls.get(m.toolCallId);
				const text = Array.isArray(m.content)
					? m.content.map((p) => p.text ?? "").join("")
					: String(m.content ?? "");
				runs.push({
					command: call.command,
					file: f,
					ts: j.timestamp ?? call.ts,
					isError: Boolean(m.isError),
					text,
					cwd,
					root: dir,
				});
			}
		}
	}
	return runs;
}

const runs = [];
for (const root of sessionRoots) {
	if (!existsSync(root)) continue;
	for (const entry of readdirSync(root)) {
		const d = join(root, entry);
		try {
			if (!statSync(d).isDirectory()) continue;
		} catch {
			continue;
		}
		runs.push(...collectRuns(d));
	}
}

// ------------------------------------------------------------------- review
function reviewInventory() {
	if (!opt.gentleAi || !existsSync(opt.gentleAi)) return null;
	try {
		const out = execFileSync(opt.gentleAi, ["review", "status", "--cwd", repo], { encoding: "utf8" });
		return JSON.parse(out);
	} catch (e) {
		return { error: String(e.message).split("\n")[0] };
	}
}
const inventory = reviewInventory();

// ------------------------------------------------------------------- report
const pad = (s, n) => String(s).padEnd(n);
const trunc = (s, n) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));

const payloads = [];
for (const docPath of opt.docs) {
	const parsed = parseDoc(read(docPath));

	const commitFacts = new Map();
	for (const t of parsed.tasks) {
		for (const c of t.commits) {
			if (commitFacts.has(c)) continue;
			const sha = git("rev-parse", "--verify", `${c}^{commit}`);
			if (!sha) {
				commitFacts.set(c, { found: false });
				continue;
			}
			const meta = git("log", "-1", "--format=%H%x1f%ad%x1f%s", "--date=iso", sha) ?? "";
			const [full, date, subject] = meta.split("\u001f");
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

	let rows = buildRows({ parsed, commitFacts, runs, repoRoot: repo });
	rows = attachReview(rows, inventory);
	const cov = coverage(rows);
	payloads.push({ doc: docPath, parsed, rows, coverage: cov, inventory });
}

// A document the parser cannot read must say so. An empty table reads as
// "nothing to report", which is indistinguishable from a clean result.
const unreadable = payloads.filter((p) => !p.parsed.specs.length && !p.parsed.tasks.length);
for (const p of unreadable) {
	console.error(
		`odd-trace: no specs and no tasks parsed from ${p.doc}\n` +
			"  sections present: " +
			JSON.stringify(p.parsed.sections) +
			"\n  run `node diagnose.mjs <dir>` to see the shapes this document uses",
	);
}
if (unreadable.length === payloads.length) process.exit(3);

if (opt.json) {
	console.log(JSON.stringify(payloads, null, 2));
	process.exit(0);
}

for (const p of payloads) {
	console.log(`\nfeature  ${p.doc}`);
	console.log(`repo     ${p.repo ?? repo}`);
	console.log(
		`specs ${p.parsed.specs.length}   tasks ${p.parsed.tasks.length}   log ${p.parsed.logs.length}   risk ${p.parsed.risk ?? "(none)"}`,
	);
	console.log(`sessions ${sessionRoots.length} root(s), ${runs.length} observed run(s)`);
	console.log();
	// A document without `## Specs` is not empty: it names work but no numbered
// requirements. Report the tasks instead of an empty table, because an empty
// table reads as "nothing to report".
if (!p.parsed.specs.length && p.parsed.tasks.length) {
		console.log(`${pad("T#", 8)}${pad("commit", 9)}checks`);
		console.log("-".repeat(60));
		for (const t of p.parsed.tasks) {
			const commits = t.commits.length ? t.commits.map((c) => c.slice(0, 7)).join(",") : "\u2014";
			console.log(`${pad(t.id, 8)}${pad(commits, 9)}${t.shape}`);
		}
		console.log(
			`\nno ## Specs section: ${p.parsed.tasks.length} task(s) parsed, 0 requirements to join.`,
		);
		console.log("  this document describes work without numbered specs, so per-requirement evidence is not expressible.");
		continue;
	}

	console.log(`${pad("S#", 5)}${pad("T#", 5)}${pad("commit", 9)}${pad("check", 30)}${pad("code", 7)}verdict`);
	console.log("-".repeat(100));
	for (const r of p.rows) {
		console.log(
			`${pad(r.spec, 5)}${pad(r.task, 5)}${pad(r.commit, 9)}${pad(trunc(r.check, 29), 30)}${pad(r.code, 7)}${r.verdict}`,
		);
	}
	console.log(`\nspec coverage: ${p.coverage.covered}/${p.coverage.total} specs have an observed passing check`);
	const inv = p.inventory;
	if (inv) {
		console.log(
			`review authority: ${
				inv.error ? `unavailable (${inv.error})` : `status=${inv.status} entries=${(inv.entries ?? []).length}`
			}`,
		);
		console.log("  the native ledger is inventory-scoped: it records candidate trees and lineages, not ODD task ids.");
	}
}
