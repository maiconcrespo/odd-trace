// Pure analysis core for gentle-trace. No I/O of its own: callers supply the
// feature document text, commit facts, transcript runs and review inventory.
// Keeping it pure is what makes the controls in tests/*.test.mjs honest — they
// exercise the same code the CLI runs, not a copy of it.

export const RUNNER_RE =
	/(^|[\s;&|(])(node\s+--experimental-strip-types\s+--test|node\s+--test|pnpm\s+(test|vitest)|npx\s+vitest|vitest|jest|pytest|python3?\s+-m\s+(unittest|pytest)|go\s+test)\b/;

// A pipeline's exit status belongs to its last command, not to the test.
export const PIPELINE_RE = /\|\s*(grep|head|tail|tee|awk|sed|cat|wc)\b|>\s*\S+/;

const strip = (t) => t.replace(/[\u2139\u2714\u2716\u2718]/g, " ");
const basename = (p) => p.split("/").pop() ?? p;

// --------------------------------------------------------------- doc parsing
export function parseDoc(doc) {
	const section = (name) => {
		const m = new RegExp(`^## ${name}\\s*$`, "m").exec(doc);
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
	let cols = null;
	for (const line of section("Tasks").split("\n")) {
		if (!line.trim().startsWith("|")) continue;
		const raw = line.split("|").slice(1, -1).map((c) => c.trim());
		if (raw.every((c) => /^:?-+:?$/.test(c))) continue;
		// Map by header name: documents use four or five columns interchangeably.
		if (!cols && raw.some((c) => /^id$/i.test(c))) {
			const lower = raw.map((c) => c.toLowerCase());
			cols = {
				id: lower.indexOf("id"),
				specs: lower.findIndex((c) => /spec/.test(c)),
				commit: lower.indexOf("commit"),
				route: lower.indexOf("route"),
				status: lower.indexOf("status"),
			};
			continue;
		}
		if (!cols) continue;
		const at = (i) => (i >= 0 ? (raw[i] ?? "") : "");
		tasks.push({
			id: at(cols.id),
			specIds: at(cols.specs).match(/S\d+/g) ?? [],
			commits: at(cols.commit).match(/\b[0-9a-f]{7,40}\b/g) ?? [],
			route: at(cols.route),
			status: at(cols.status),
		});
	}

	const risk = /^Risk:\s*(.+)$/m.exec(doc)?.[1]?.trim() ?? null;
	const logs = [];
	for (const line of section("Log").split("\n")) {
		const m = /^\s*[-*]\s*\*\*(L\d+)\*\*\s*(.*)$/.exec(line);
		if (m) logs.push({ id: m[1], text: m[2].trim() });
	}
	return { specs, tasks, risk, logs };
}

// ------------------------------------------------------------ run selection
// Precision beats recall: a test filename that merely appears in `git diff`,
// `grep` or a comment is not a check.
export function selectRuns(runs, testFiles, repoRoot) {
	if (!testFiles.length) return [];
	const base = testFiles.map(basename);
	return runs.filter((r) => {
		if (!RUNNER_RE.test(r.command)) return false;
		if (!base.some((b) => r.command.includes(b))) return false;
		// A run in another checkout answers a different tree.
		if (repoRoot && r.cwd && r.cwd !== repoRoot) return false;
		return true;
	});
}

export function classifyOutcome(run) {
	const t = strip(run.text ?? "");
	const tail = t.trim().split("\n").slice(-3).join(" ⏎ ");
	if (PIPELINE_RE.test(run.command)) {
		return { code: "piped", tail, note: "exit status belongs to the filter, not the test" };
	}
	const explicit = /(?:exit code|EXIT:?)\s*(\d+)/i.exec(run.text ?? "");
	if (explicit) return { code: explicit[1], tail };
	if (/ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find (package|module)/.test(run.text ?? "")) {
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

const VERDICT = {
	0: "observed pass",
	piped: "NOT EVIDENCE (pipeline)",
	error: "NOT EVIDENCE (load error)",
	"?": "runner ran, outcome not in log",
};

// --------------------------------------------------------------- the join
/**
 * @param {object} input
 * @param {ReturnType<typeof parseDoc>} input.parsed
 * @param {Map<string, object>} input.commitFacts  commit ref -> fact
 * @param {Array<object>} input.runs               observed transcript runs
 * @param {string} input.repoRoot
 */
export function buildRows({ parsed, commitFacts, runs, repoRoot }) {
	const rows = [];
	for (const s of parsed.specs) {
		const owning = parsed.tasks.filter((t) => t.specIds.includes(s.id));
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
				const observed = selectRuns(runs, fact.testFiles, repoRoot).sort((a, b) =>
					String(b.ts).localeCompare(String(a.ts)),
				);
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
				// A run performed before the commit cannot speak about it.
				const commitTime = Date.parse(fact.date ?? "");
				const after = observed.filter((r) => {
					const ts = Date.parse(String(r.ts));
					return Number.isFinite(ts) && Number.isFinite(commitTime) && ts >= commitTime;
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
				const o = classifyOutcome(run);
				const tested = run.command.split(/\s+/).find((w) => /\.(test|spec)\./.test(w));
				rows.push({
					spec: s.id,
					task: t.id,
					commit: fact.sha.slice(0, 7),
					check: tested ? basename(tested) : "bash",
					code: o.code,
					verdict: VERDICT[o.code] ?? `observed ${o.code}`,
					note: o.note ?? null,
					tail: o.tail,
					runAt: run.ts,
					runIn: run.cwd ?? null,
				});
			}
		}
	}
	return rows;
}

/**
 * Review authority is inventory-scoped, not task-scoped: the native ledger
 * records candidate trees and lineages, not ODD task ids. Rather than invent a
 * mapping, report the inventory and, when an entry names a commit this feature
 * mentions, surface it next to that task.
 */
export function attachReview(rows, inventory) {
	if (!inventory || inventory.error) return rows.map((r) => ({ ...r, review: "unavailable" }));
	const entries = inventory.entries ?? [];
	const found = InventoryIndex(entries);
	return rows.map((r) => {
		const hits = found(r.commit);
		return { ...r, review: hits.length ? `lineage ${hits.join(", ")}` : entries.length ? "no match" : "none recorded" };
	});
}

function InventoryIndex(entries) {
	const byCommit = new Map();
	for (const e of entries) {
		const refs = [e.commit, e.candidate_commit, e.head, e.candidate?.commit].filter(Boolean);
		for (const ref of refs) {
			const short = String(ref).slice(0, 7).toLowerCase();
			if (!byCommit.has(short)) byCommit.set(short, []);
			byCommit.get(short).push(String(e.lineage_id ?? e.lineage ?? "?").slice(0, 8));
		}
	}
	return (commit) => (commit && commit !== "—" ? (byCommit.get(String(commit).toLowerCase()) ?? []) : []);
}

export function coverage(rows) {
	const bySpec = new Map();
	for (const r of rows) bySpec.set(r.spec, (bySpec.get(r.spec) ?? false) || r.verdict === "observed pass");
	return { covered: [...bySpec.values()].filter(Boolean).length, total: bySpec.size };
}
