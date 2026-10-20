// A throwaway git repository built at test time.
//
// The suite must not depend on the machine it runs on. An earlier version
// pointed at a real local checkout, so anyone who cloned this project saw nine
// tests fail for a reason that had nothing to do with the code.
//
// This fixture creates its own repository, with its own commits, in a temp
// directory, and removes it afterwards. Nothing outside the temp directory is
// read or written.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const TEST_FILE = "tests/widget.test.js";

/**
 * Build a repository with one commit that touches a test file.
 * Returns the repository path plus the commit facts the analysis needs.
 */
export function createFixtureRepo() {
	const root = mkdtempSync(join(tmpdir(), "odd-trace-repo-"));
	const git = (...args) =>
		execFileSync("git", ["-C", root, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: {
				...process.env,
				GIT_AUTHOR_NAME: "fixture",
				GIT_AUTHOR_EMAIL: "fixture@example.invalid",
				GIT_COMMITTER_NAME: "fixture",
				GIT_COMMITTER_EMAIL: "fixture@example.invalid",
				GIT_CONFIG_GLOBAL: "/dev/null",
				GIT_CONFIG_SYSTEM: "/dev/null",
			},
		}).trim();

	git("init", "--quiet");
	mkdirSync(join(root, "tests"), { recursive: true });
	writeFileSync(join(root, TEST_FILE), "// fixture test file\n");
	writeFileSync(join(root, "README.md"), "# fixture\n");
	git("add", ".");
	git("commit", "--quiet", "-m", "fixture: add widget test");

	const sha = git("rev-parse", "HEAD");
	// The commit is created "now"; commitFacts uses that real date so the stale
	// comparison depends on the fixture's own history, not on a literal.
	const date = git("log", "-1", "--format=%cI", "HEAD");

	const cleanup = () => rmSync(root, { recursive: true, force: true });
	return { root, sha, short: sha.slice(0, 7), date, git, cleanup };
}

/** Commit facts in the shape buildRows expects, without shelling out per test. */
export function commitFactsFor(repo, { found = true } = {}) {
	return new Map([
		[
			repo.short,
			{
				found,
				sha: repo.sha,
				date: repo.date,
				testFiles: [TEST_FILE],
				files: [TEST_FILE, "README.md"],
			},
		],
	]);
}

// ---------------------------------------------------------------- transcripts
/**
 * Write a Pi-shaped transcript into a temp directory.
 *
 * `outcome` decides what the tool must conclude:
 *   pass     - a real runner invocation, all passing
 *   pipeline - the same run piped through grep, which fakes a zero exit
 *   fail     - a real runner invocation reporting failures
 *   stale    - a passing run dated before the commit
 */
export function writeTranscript(repo, outcome) {
	const dir = mkdtempSync(join(tmpdir(), "odd-trace-sessions-"));
	const projectDir = join(dir, "--fixture--");
	mkdirSync(projectDir, { recursive: true });

	const command = {
		pass: `cd ${repo.root} && node --test ${TEST_FILE}`,
		pipeline: `cd ${repo.root} && node --test ${TEST_FILE} 2>&1 | grep -m2 Error | head -3`,
		fail: `cd ${repo.root} && node --test ${TEST_FILE}`,
		stale: `cd ${repo.root} && node --test ${TEST_FILE}`,
	}[outcome];

	const text = {
		pass: "# tests 12\n# pass 12\n# fail 0\n",
		pipeline: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'x'\n",
		fail: "# tests 12\n# pass 10\n# fail 2\n",
		stale: "# tests 12\n# pass 12\n# fail 0\n",
	}[outcome];

	// Relative to the commit this fixture created: "stale" runs before it, every
	// other outcome after it, so no literal date can rot.
	const committed = Date.parse(repo.date);
	const when = new Date(outcome === "stale" ? committed - 86_400_000 : committed + 3_600_000).toISOString();

	const lines = [
		{ type: "session", version: 3, id: "fixture", timestamp: when, cwd: repo.root },
		{
			type: "message",
			timestamp: when,
			message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command } }] },
		},
		{
			type: "message",
			timestamp: when,
			message: {
				role: "toolResult",
				toolCallId: "c1",
				toolName: "bash",
				isError: outcome === "fail",
				durationMs: 900,
				content: [{ type: "text", text }],
			},
		},
	];
	writeFileSync(join(projectDir, "session.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Read a transcript back into the run shape `selectRuns` consumes. */
export function runsFrom(sessionsDir) {
	const runs = [];
	const projectDir = join(sessionsDir, "--fixture--");
	for (const f of readdirSync(projectDir).filter((x) => x.endsWith(".jsonl"))) {
		const lines = readFileSync(join(projectDir, f), "utf8").trim().split("\n");
		const calls = new Map();
		let cwd = null;
		for (const line of lines) {
			const j = JSON.parse(line);
			if (j.type === "session" && j.cwd) cwd = j.cwd;
			if (j.type !== "message" || !j.message) continue;
			const m = j.message;
			if (m.role === "assistant" && Array.isArray(m.content)) {
				for (const part of m.content) {
					if (part.type === "toolCall") calls.set(part.id, { command: String(part.arguments?.command ?? ""), ts: j.timestamp });
				}
			} else if (m.role === "toolResult" && calls.has(m.toolCallId)) {
				const c = calls.get(m.toolCallId);
				runs.push({
					command: c.command,
					ts: j.timestamp,
					isError: Boolean(m.isError),
					text: Array.isArray(m.content) ? m.content.map((x) => x.text ?? "").join("") : String(m.content ?? ""),
					cwd,
				});
			}
		}
	}
	return runs;
}
