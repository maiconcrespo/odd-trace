# gentle-trace

A read-only join over evidence that gentle-shell already produces but never
connects:

```
S# (spec) -> T# (task) -> commit -> observed check run -> review authority
```

It emits no verdict, approves nothing, writes nothing, and never replaces the
native reviewer. It reports what was observed, and where the chain is missing.

---

## The problem, in one paragraph

gentle-shell already records every ingredient separately: the feature document
holds `S#` specs and `T#` tasks, git holds the commits, Pi's session
transcripts hold every check run with its real output, and native Gentle AI
holds review authority. **Nothing joins them.** Today the only link between a
requirement and the evidence that it was verified is prose a human typed by
hand:

```markdown
- [x] Merge ... Evidence: `f6e6d93c`.
```

If that line is missing, wrong, or the commit is gone, nobody can tell. When a
feature is resumed weeks later, or when a reviewer asks "was this requirement
actually verified?", the answer is markdown archaeology plus trust.

`gentle-trace` answers it in one command, and refuses to answer when the
evidence is not there.

---

## What it does not do

These refusals are the design, not limitations to be fixed later:

1. **It never emits a verdict.** It reports what a transcript contains.
2. **It never writes.** No cache, no ledger, no state file. Read-only in the
   strict sense: `git status` is unchanged after a run.
3. **It never replaces the native reviewer.** Verdicts are admitted natively or
   they do not exist.
4. **It never infers evidence.** A missing run is reported as missing.

## What it refuses to count as evidence

Each of these was a real false positive found while building it:

| Situation | Report |
|---|---|
| `node --test x | grep Error` — exit status belongs to `grep` | `NOT EVIDENCE (pipeline)` |
| `ERR_MODULE_NOT_FOUND` — the runner never reached the test | `NOT EVIDENCE (load error)` |
| a run performed before the commit it is attributed to | `STALE CHECK` |
| a run in a different worktree | rejected by `cwd` match |
| a filename that merely appears in `git diff` / `grep` | rejected by runner detection |
| a runner that ran but whose outcome is not in the log | `runner ran, outcome not in log` — never rounded up to a pass |

---

## Usage

```bash
# one feature document
node trace.mjs --doc odd/tasks/<feature>.md --repo .

# several documents at once
node trace.mjs --doc a.md --doc b.md --repo .

# include evidence from another Pi home (worktrees)
node trace.mjs --doc odd/tasks/x.md --repo . --sessions ~/.gentle-shell/agent/sessions,/other/home/.gentle-shell/agent/sessions

# include the native review inventory
node trace.mjs --doc odd/tasks/x.md --repo . --gentle-ai /path/to/gentle-ai

# machine-readable
node trace.mjs --doc odd/tasks/x.md --repo . --json
```

Output:

```
S#   T#   commit   check                         code   verdict
--------------------------------------------------------------------
S1   T1   b8b1ba1  4 file(s), no run found       —      NO CHECK OBSERVED
S3   —    —        —                             —      NO TASK
S6   T2   7ff4157  1 run(s) predate the commit   —      STALE CHECK

spec coverage: 0/7 specs have an observed passing check
```

### Verdict vocabulary

| Verdict | Meaning |
|---|---|
| `observed pass` | a runner ran this commit's test file after the commit and reported all passing |
| `observed fail` | same, and it reported failures |
| `observed <n>` | same, exit code `n` |
| `NOT EVIDENCE (pipeline)` | the exit status came from a filter, not the runner |
| `NOT EVIDENCE (load error)` | the runner could not load; the test never ran |
| `STALE CHECK` | the only runs predate the commit |
| `NO CHECK OBSERVED` | no transcript on this machine ran this commit's tests |
| `NO TASK` | the spec belongs to no task row |
| `NO COMMIT IN DOC` | the task row names no commit |
| `COMMIT MISSING` | the commit does not exist in this clone |
| `runner ran, outcome not in log` | a run happened; the transcript does not prove the result |

---

## Tooling

| File | Purpose |
|---|---|
| `trace.mjs` | the CLI |
| `lib/analyze.mjs` | pure analysis core — no I/O, so tests exercise the shipped path |
| `tests/analyze.test.mjs` | 23 tests |
| `probe.mjs` | explain why one commit's transcript entries were accepted or rejected |
| `coverage-report.mjs` | how many documents in a directory the join can read |
| `corpus-audit.mjs` | how much of the evidence chain resolves in this clone |
| `diagnose.mjs` | which documents still resist the parser, and the offending line |

```bash
node --test tests/*.test.mjs          # 23 pass
node corpus-audit.mjs <dir> <repo>    # evidence-chain coverage
node coverage-report.mjs <dir>        # parser coverage
```

### Controls

A checker that only ever prints "missing" proves nothing, so the suite ships a
positive control and three negatives. All four run against the same fixture
document with different transcripts:

| Fixture | Expected |
|---|---|
| `fixture/pos` | `observed pass`, 2/2 specs covered |
| `fixture/neg-pipeline` | `NOT EVIDENCE (pipeline)` |
| `fixture/neg-fail` | `observed fail` |
| `fixture/neg-stale` | `STALE CHECK` |

---

## Findings

Measured against the 144 feature documents in `gentle-shell/odd/tasks`, with a
full 6,281-commit clone. Reproduce with `node corpus-audit.mjs`.

| | |
|---|---|
| documents | 144 |
| with `## Specs` | 46 |
| with readable task rows | 106 |
| joinable (both) | 46 |
| specs parsed | 307 |
| tasks parsed | 486 |
| commits referenced by task rows | 183 |
| **commits that exist in the clone** | **85** |
| **commits missing from the clone** | **98** |
| documents whose referenced commits all resolve | 23 |
| **documents with at least one missing commit** | **24** |
| documents with tasks but no commit reference | 59 |
| documents with no `## Log` section | 98 |

### What those numbers mean

1. **The verification chain is broken at the source, not at the tool.** 98 of
   183 referenced commits do not exist in the repository clone. They came from
   worktrees or from rewritten history. A document can read *"done, verified
   (L7)"* and be entirely unresolvable here.

2. **A pipeline can fake a green suite, and it already did.** A real transcript
   from this repository contains:

   ```bash
   node --experimental-strip-types --test tests/yolo-mode.test.ts 2>&1 \
     | grep -m2 "ERR_MODULE_NOT_FOUND\|Error \[" | head -3
   ```

   It exited `0` while the suite **failed to load** (`Cannot find package
   '@earendil-works/pi-tui'`). The exit status belonged to `grep`. Any gate
   reading exit codes accepts this as success.

3. **The ODD section contract is a naming convention, not a grammar.** All 144
   documents have the required sections. Beneath the section names there are at
   least five spec shapes and three task-row shapes, used interchangeably in the
   same repository. See `FORMAT.md`.

4. **59 documents describe completed work with no commit reference at all.**
   The task is marked done and the work is unlinkable.

5. **98 of 144 documents have no `## Log`**, so the verbatim user request and
   the corrections that shaped the work are not recoverable from the document.

### A note on the review dimension

Native review authority is inventory-scoped: the ledger records candidate trees
and lineages, not ODD task ids. `attachReview` matches a lineage to a commit
only when the inventory names that commit, and otherwise reports `no match` or
`none recorded`. It never invents a mapping. Any finer link belongs inside the
native ledger — see `gentle-shell#554`.

---

## Relation to upstream work

- **`gentle-shell#554`** asks for a human-readable audit trail per lineage and
  executable evidence per finding. It lives *inside* native authority.
- **This tool is complementary**: it stays outside as a read-only join and never
  touches the ledger.
- **`gentle-shell#2366`** and **`#2369`** both note that harness effects are
  asserted rather than measured. `corpus-audit.mjs` is a small, concrete
  measurement of one such claim.

## Status

Prototype. Not wired into gentle-shell, no extension registered, nothing
persisted. It exists to answer one question with evidence: **does the join tell
you something you do not already know?** Findings 1, 2 and 4 say yes.

The ODD feature-document format used by this tool, and the minimal contract
that would make the join complete, are documented in [`FORMAT.md`](FORMAT.md).
