// Pure analysis core for odd-trace. No I/O of its own: callers supply the
// feature document text, commit facts, transcript runs and review inventory.
// Keeping it pure is what makes the controls in tests/*.test.mjs honest — they
// exercise the same code the CLI runs, not a copy of it.
//
// The ODD feature-document format is a naming convention, not a grammar. A real
// repository contains at least five task-row shapes and several spec shapes.
// Every parser here is deliberately tolerant about shape and strict about
// meaning: it never invents a commit, a spec id, or an outcome that the
// document does not contain.

export const RUNNER_RE =
	/(^|[\s;&|(])(node\s+--experimental-strip-types\s+--test|node\s+--test|pnpm\s+(test|vitest)|npx\s+vitest|vitest|jest|pytest|python3?\s+-m\s+(unittest|pytest)|go\s+test)\b/;

// A pipeline's exit status belongs to its last command, not to the test. Only a
// pipe into a filter does that. A redirect to a file (`> out.log 2>&1`) leaves
// the runner as the last command, so `$?` is still the runner's status.
export const PIPELINE_RE = /\|\s*(grep|head|tail|tee|awk|sed|cat|wc)\b/;

const strip = (t) => t.replace(/[\u2139\u2714\u2716\u2718]/g, " ");
const basename = (p) => p.split("/").pop() ?? p;

// ------------------------------------------------------------------ sections
const sectionOf = (doc, name) => {
	const m = new RegExp(`^##\\s+${name}\\s*$`, "m").exec(doc);
	if (!m) return "";
	const rest = doc.slice(m.index + m[0].length);
	const next = /^##\s/m.exec(rest);
	return next ? rest.slice(0, next.index) : rest;
};

/**
 * `S#` shapes seen in the wild - bold is optional, and a dash, colon, period or
 * parenthetical tag may follow the id directly:
 *   - **S1** text
 *   - **S1 - Title.** text
 *   - S1 - Title. text                    (no bullet, no bold)
 *   - S1 (user, verbatim): "..."          (no bold, tag)
 *   - S1. User: "..."                     (period)
 *   1. S1: "..."                          (ordered list)
 */
export function parseSpecs(doc) {
	// A feature document may name its requirements differently. `## Specs` with
	// S# is the ODD convention; `## Acceptance criteria` is the same idea written
	// as a list (numbered, bulleted or checkboxes) with no ids at all. Both are
	// tried, in that order.
	for (const name of ["Specs", "Acceptance criteria", "Acceptance Criteria", "Requirements"]) {
		const body = sectionOf(doc, name);
		if (!body) continue;
		const specs = parseSpecBody(body, name);
		if (specs.length) return specs;
	}
	return [];
}

function parseSpecBody(body, name) {
	const specs = [];
	let ordinal = 0;
	// Ids the author wrote anywhere in this section are reserved up front, so an
	// unnumbered item that appears earlier cannot be given an id that a later
	// explicit one already owns.
	const taken = new Set();
	for (const line of body.split("\n")) {
		const explicit = /^\s*(?:[-*]|\d+[.)])?\s*(?:\*\*)?(S#?\d+)\b/.exec(line);
		if (explicit) taken.add(explicit[1].replace("#", ""));
	}
	for (const line of body.split("\n")) {
		// The id must open the line's content: an `S3` mentioned mid-sentence is a
		// cross-reference, not a spec definition.
		const m = /^\s*(?:[-*]|\d+[.)])?\s*(?:\*\*)?(S#?\d+)\b\s*(.*)$/.exec(line);
		if (m) {
			const rest = m[2]
				.replace(/^\*\*/, "")
				.replace(/^[*.-\u2014\u2013:]+\s*/, "")
				.trim();
			specs.push({ id: m[1].replace("#", ""), text: rest });
			continue;
		}
		// Outside `## Specs`, requirements carry no ids, so each top-level list item
		// is numbered in document order. Three item shapes occur in practice:
		//   1. numbered     - [x] checkbox     - plain bullet
		// A continuation line (no marker) and an indented sub-item are detail of the
		// previous criterion, never a new one: only a marker at column 0 counts.
		if (name !== "Specs") {
			const item = /^(?:\d+[.)]|[-*])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/.exec(line);
			if (item) {
				do ordinal += 1;
				while (taken.has(`S${ordinal}`));
				specs.push({ id: `S${ordinal}`, text: item[1].trim(), derived: true });
			}
		}
	}
	return specs;
}

/**
 * Task rows appear as a markdown table in some documents and as prose, bullets
 * or an ordered list in others. Each shape is tried in turn; the first that
 * matches a line claims it. Column mapping inside a table is by header name,
 * because the same repository uses four and five columns interchangeably.
 */
// Task sections are headed `## Tasks`, and some documents add a qualifier:
// `## Tasks and routes`, `## Tasks and acceptance`, `## Tasks / acceptance`. The
// exact heading is tried first; a qualified one is the fallback. The qualifier
// must be separated from the word by a space or a slash, so `## Taskset notes`
// is never mistaken for a task section.
const TASKS_QUALIFIED = /^##\s+Tasks(?=[\s/])[^\n]*$/m;

function tasksSection(doc) {
	const exact = sectionOf(doc, "Tasks");
	if (exact) return exact;
	const m = TASKS_QUALIFIED.exec(doc);
	if (!m) return "";
	const rest = doc.slice(m.index + m[0].length);
	const next = /^##\s/m.exec(rest);
	return next ? rest.slice(0, next.index) : rest;
}

export function parseTasks(doc) {
	// Some documents track work in `## Status` as a checkbox list, with no ids and
	// no section named `Tasks`. Fall back to it when `## Tasks` yields nothing.
	const tasks = parseTasksBody(tasksSection(doc));
	if (tasks.length) return tasks;
	return parseTasksBody(sectionOf(doc, "Status")).map((t) => ({ ...t, shape: "status" }));
}

function parseTasksBody(body) {
	const tasks = [];
	let cols = null;

	const pushUnique = (task) => {
		if (!task.id) return;
		if (tasks.some((t) => t.id === task.id)) return;
		tasks.push(task);
	};

	for (const rawLine of body.split("\n")) {
		const line = rawLine.trim();
		if (!line) continue;

		// ---- table rows -------------------------------------------------
		if (line.startsWith("|")) {
			const raw = line.split("|").slice(1, -1).map((c) => c.trim());
			if (raw.every((c) => /^:?-+:?$/.test(c))) continue;
			if (!cols && raw.some((c) => /^(id|unit|task)$/i.test(c))) {
				const lower = raw.map((c) => c.toLowerCase());
				cols = {
					id: lower.findIndex((c) => /^(id|unit|task)$/.test(c)),
					specs: lower.findIndex((c) => /spec/.test(c)),
					commit: lower.findIndex((c) => /commit|evidence|sha/.test(c)),
					route: lower.indexOf("route"),
					status: lower.indexOf("status"),
				};
				continue;
			}
			if (!cols) continue;
			const at = (i) => (i >= 0 ? (raw[i] ?? "") : "");
			const cell = at(cols.id).replace(/[`*]/g, "").trim();
			// Table ids are sometimes bare letters (`N0`, `N1a`), not only `T1`.
			const id = /^[A-Z]\d+[a-z]?$/.test(cell) ? cell : (/\b([A-Z]\d+[a-z]?)\b/.exec(cell)?.[1] ?? "");
			// A hash may live in any cell: `Unit | Intent` tables put the commit in
			// the Intent prose, and some put it beside the id.
			pushUnique({
				id,
				specIds: extractSpecIds(raw.join(" ")),
				commits: extractCommits(raw.join(" ")),
				route: at(cols.route),
				status: at(cols.status),
				shape: "table",
			});
			continue;
		}

		// ---- bullet / ordered list --------------------------------------
		//   - T1 [x] S1-S7 — work. Route: inline. Commit: `250cec03`
		//   1. [x] RED→GREEN: work                      (no T#, no commits)
		//   - **T2** (S1–S4) · route: writer · work     (dash separator)
		const bullet = /^(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
		if (bullet) {
			const body = bullet[1];
			// Ids are `T1`, `T3a`, and also project-prefixed forms like `SN-2`.
			// `- [x] 1. Scaffold` inside `## Status` has no id at all; number it.
			let idMatch = /\b([A-Z]{1,3}-?\d+[a-z]?)\b/.exec(body);
			if (!idMatch) {
				const ordinal = /^\[([ x])\]\s*(\d+)[.)]/.exec(body);
				if (!ordinal) continue;
				idMatch = [null, `T${ordinal[2]}`];
			}
			if (!idMatch) continue;
			pushUnique({
				id: idMatch[1].replace(/-/g, ""),
				specIds: extractSpecIds(body),
				commits: extractCommits(body),
				route: /route:\s*([^|·;.]+)/i.exec(body)?.[1]?.trim() ?? "",
				status: /\[x\]/i.test(body) ? "done" : "",
				shape: "bullet",
			});
			continue;
		}

		// ---- prose ------------------------------------------------------
		//   T1 · S1,S2 · inline · test-first · **DONE** — work
		const prose = /^(T\d+[a-z]?)\s*[·|:]\s*(.*)$/.exec(line);
		if (prose) {
			pushUnique({
				id: prose[1],
				specIds: extractSpecIds(prose[2]),
				commits: extractCommits(prose[2]),
				route: /^(S[\d,\s-]*)?\s*[·|]\s*([A-Za-z][\w +-]*?)\s*[·|]/.exec(prose[2])?.[2]?.trim() ?? "",
				status: /DONE/i.test(prose[2]) ? "done" : "",
				shape: "prose",
			});
		}
	}
	return tasks;
}

// `S1`, `S1-S7`, `S1, S2, S5`, `S11` — expand ranges when both ends are close.
function extractSpecIds(text) {
	const ids = new Set();
	for (const m of text.matchAll(/\bS(\d+)(?:\s*[-\u2013]\s*S?(\d+))?/g)) {
		const from = Number(m[1]);
		const to = m[2] ? Number(m[2]) : from;
		if (Number.isFinite(to) && to >= from && to - from <= 30) {
			for (let i = from; i <= to; i++) ids.add(`S${i}`);
		} else if (m[2]) {
			// A range too wide to be real: keep both endpoints rather than expand
			// into hundreds of ids, and never silently drop the far end.
			ids.add(`S${m[1]}`);
			ids.add(`S${m[2]}`);
		} else {
			ids.add(`S${m[1]}`);
		}
	}
	return [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
}

// Only hashes that look like commits. `250cec03` and `b8b1ba1a3` both qualify;
// a bare `S1` or an issue number does not.
//
// A hex token is a commit only if its length is one git can produce: an
// abbreviation of 7-12 characters, or a full 40-character id. Documents also
// carry GitHub Actions run ids (10-11 digits) and native review lineage ids
// (16 hex characters); counting those inflated the "missing commit" figure.
function extractCommits(text) {
	const out = [];
	for (const m of text.matchAll(/(?<![0-9a-zA-Z-])([0-9a-f]{7,40})(?![0-9a-zA-Z])/g)) {
		const token = m[1];
		const plausible = token.length === 40 || (token.length >= 7 && token.length <= 12);
		// Ten or more digits and nothing else is a run id, never an abbreviation.
		const runId = /^\d{10,}$/.test(token);
		if (plausible && !runId) out.push(token);
	}
	return [...new Set(out)];
}

export function parseLog(doc) {
	const logs = [];
	for (const line of sectionOf(doc, "Log").split("\n")) {
		const m = /^\s*[-*]\s*\*\*(L\d+)\*\*\s*(.*)$/.exec(line);
		if (m) logs.push({ id: m[1], text: m[2].trim() });
	}
	return logs;
}

export function parseDoc(doc) {
	return {
		specs: parseSpecs(doc),
		tasks: parseTasks(doc),
		risk: /^Risk:\s*(.+)$/m.exec(doc)?.[1]?.trim() ?? null,
		logs: parseLog(doc),
		sections: {
			specs: Boolean(sectionOf(doc, "Specs")),
			tasks: Boolean(tasksSection(doc)),
			log: Boolean(sectionOf(doc, "Log")),
		},
	};
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
	const tail = t.trim().split("\n").slice(-3).join(" \u23ce ");
	if (PIPELINE_RE.test(run.command)) {
		return { code: "piped", tail, note: "exit status belongs to the filter, not the test" };
	}
	const explicit = /(?:exit code\s*:?|EXIT\s*[:=])\s*(\d+)/i.exec(run.text ?? "");
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
export function buildRows({ parsed, commitFacts, runs, repoRoot }) {
	const rows = [];
	for (const s of parsed.specs) {
		const owning = parsed.tasks.filter((t) => t.specIds.includes(s.id));
		if (!owning.length) {
			rows.push({ spec: s.id, task: "\u2014", commit: "\u2014", check: "\u2014", code: "\u2014", verdict: "NO TASK" });
			continue;
		}
		for (const t of owning) {
			if (!t.commits.length) {
				rows.push({
					spec: s.id,
					task: t.id,
					commit: "\u2014",
					check: "\u2014",
					code: "\u2014",
					verdict: "NO COMMIT IN DOC",
				});
				continue;
			}
			for (const c of t.commits) {
				const fact = commitFacts.get(c);
				if (!fact?.found) {
					rows.push({ spec: s.id, task: t.id, commit: c, check: "\u2014", code: "\u2014", verdict: "COMMIT MISSING" });
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
						code: "\u2014",
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
						code: "\u2014",
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
 * mentions, surface it next to that row.
 */
export function attachReview(rows, inventory) {
	if (!inventory || inventory.error) return rows.map((r) => ({ ...r, review: "unavailable" }));
	const entries = inventory.entries ?? [];
	const index = inventoryIndex(entries);
	return rows.map((r) => {
		const hits = index(r.commit);
		return {
			...r,
			review: hits.length ? `lineage ${hits.join(", ")}` : entries.length ? "no match" : "none recorded",
		};
	});
}

function inventoryIndex(entries) {
	const byCommit = new Map();
	for (const e of entries) {
		const refs = [e.commit, e.candidate_commit, e.head, e.candidate?.commit].filter(Boolean);
		for (const ref of refs) {
			const short = String(ref).slice(0, 7).toLowerCase();
			if (!byCommit.has(short)) byCommit.set(short, []);
			byCommit.get(short).push(String(e.lineage_id ?? e.lineage ?? "?").slice(0, 8));
		}
	}
	return (commit) => (commit && commit !== "\u2014" ? (byCommit.get(String(commit).toLowerCase()) ?? []) : []);
}

export function coverage(rows) {
	const bySpec = new Map();
	for (const r of rows) bySpec.set(r.spec, (bySpec.get(r.spec) ?? false) || r.verdict === "observed pass");
	return { covered: [...bySpec.values()].filter(Boolean).length, total: bySpec.size };
}

export function summarize(rows) {
	const counts = new Map();
	for (const r of rows) counts.set(r.verdict, (counts.get(r.verdict) ?? 0) + 1);
	return counts;
}
