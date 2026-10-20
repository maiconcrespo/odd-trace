#!/usr/bin/env node
// Diagnostic helper for the gentle-trace prototype: for a given commit, show
// every transcript entry whose command mentions a test file the commit changed,
// and why the prototype accepted or rejected it. Read-only.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";

const [, , commit, repo = process.cwd()] = process.argv;
if (!commit) {
	console.error("usage: probe.mjs <commit> [repo]");
	process.exit(2);
}

const git = (...a) =>
	execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

const files = git("show", "--name-only", "--format=", commit).split("\n").filter(Boolean);
const testFiles = files.filter((f) => /(^|\/)(tests?|__tests__)\//.test(f) || /\.(test|spec)\./.test(f));
const base = testFiles.map((f) => basename(f));
console.log(`commit ${commit}`);
console.log(`test files changed: ${testFiles.join(", ") || "(none)"}`);

const RUNNER_RE =
	/(^|[\s;&|(])(node\s+--experimental-strip-types\s+--test|node\s+--test|pnpm\s+(test|vitest)|npx\s+vitest|vitest|jest|pytest|python3?\s+-m\s+(unittest|pytest)|go\s+test)\b/;

const root = join(process.env.HOME ?? "", ".gentle-shell/agent/sessions");
let hits = 0;
let accepted = 0;

for (const dirName of readdirSync(root)) {
	const dir = join(root, dirName);
	try {
		if (!statSync(dir).isDirectory()) continue;
	} catch {
		continue;
	}
	for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
		const lines = readFileSync(join(dir, f), "utf8").trim().split("\n");
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
					if (p.type === "toolCall") {
						calls.set(p.id, { name: p.name, command: String(p.arguments?.command ?? "") });
					}
				}
			} else if (m.role === "toolResult" && calls.has(m.toolCallId)) {
				const call = calls.get(m.toolCallId);
				if (!base.some((b) => call.command.includes(b))) continue;
				hits++;
				const isRunner = RUNNER_RE.test(call.command);
				const cwdOk = !cwd || cwd === repo;
				const text = Array.isArray(m.content)
					? m.content.map((p) => p.text ?? "").join("")
					: String(m.content ?? "");
				const status = isRunner && cwdOk ? "ACCEPT" : "reject";
				if (status === "ACCEPT") accepted++;
				const why = !isRunner ? "no test-runner invocation" : !cwdOk ? `cwd ${cwd} != repo` : "ok";
				console.log(
					`\n[${status}] ${why}\n  session ${dirName}/${f.slice(0, 30)}\n  ts ${j.timestamp}  isError=${m.isError}\n  cmd ${call.command.slice(0, 260).replace(/\n/g, " ⏎ ")}\n  tail ${JSON.stringify(text.slice(-200))}`,
				);
			}
		}
	}
}

console.log(`\n${hits} transcript entries mention a changed test file; ${accepted} are accepted runner runs.`);
if (accepted === 0) {
	console.log("No observation of these tests exists in any transcript on this machine.");
}
