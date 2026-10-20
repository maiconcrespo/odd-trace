# odd-trace

A read-only join over evidence that a project already produces but rarely
connects:

```
S# (spec) -> T# (task) -> commit -> observed check run -> review authority
```

It emits no verdict, approves nothing, writes nothing, and never replaces a
native reviewer. It reports what was observed, and where the chain is missing.

`odd-trace` is an independent tool for projects that keep ODD (Organic Driven
Development) feature documents. It is not part of, endorsed by, or affiliated
with Gentle AI or gentle-shell; it reads their documents and transcripts.

---

## The problem, in one paragraph

A feature document holds `S#` specs and `T#` tasks, git holds the commits, the
agent's session transcripts hold every check run with its real output, and a
native reviewer may hold review authority. **Nothing joins them.** Today the only
link between a requirement and the evidence that it was verified is prose a human
typed by hand:

```markdown
- [x] Merge ... Evidence: `f6e6d93c`.
```

If that line is missing, wrong, or the commit is unreachable, nobody can tell.
When a feature is resumed weeks later, or when a reviewer asks "was this
requirement actually verified?", the answer is markdown archaeology plus trust.

`odd-trace` answers it in one command, and refuses to answer when the evidence is
not there.

---

## Try it

```bash
git clone <repo> && cd odd-trace
npm test        # no dependencies, no install step
```

The suite builds its own git repository and transcripts in a temp directory, so
it passes on a machine that has never seen the author's checkout. See
[`CONTRIBUTING.md`](CONTRIBUTING.md).

## Usage

Stand inside the repository you are auditing and run one command. See
[`USAGE.md`](USAGE.md) for the full workflow, what to read first, and every
verdict.

```bash
cd /path/to/repo
node /path/to/odd-trace/trace.mjs --doc odd/tasks/<feature>.md
```

```bash
# explicit repo, from anywhere
node trace.mjs --doc odd/tasks/<feature>.md --repo /path/to/repo

# several documents at once
node trace.mjs --doc a.md --doc b.md --repo .

# include evidence from another agent home (worktrees)
node trace.mjs --doc odd/tasks/x.md --repo . --sessions /home/a/sessions,/home/b/sessions

# include the native review inventory
node trace.mjs --doc odd/tasks/x.md --repo . --gentle-ai /path/to/gentle-ai

# machine-readable
node trace.mjs --doc odd/tasks/x.md --repo . --json
```

Output (the document and counts are illustrative):

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

## What it does not do

These refusals are the design, not limitations to be fixed later:

1. **It never emits a verdict.** It reports what a transcript contains.
2. **It never writes.** No cache, no ledger, no state file. `git status` is
   unchanged after a run.
3. **It never replaces a native reviewer.** Verdicts are admitted natively or they
   do not exist.
4. **It never infers evidence.** A missing run is reported as missing.

## What it refuses to count as evidence

Each refusal is a rule of principle. Only the last row was a defect found in this
tool's own first version.

| Situation | Report |
|---|---|
| a test run through a pipe into a filter (`… \| grep Error`): the exit status belongs to the filter, not the runner | `NOT EVIDENCE (pipeline)` |
| `ERR_MODULE_NOT_FOUND`: the runner never reached the test | `NOT EVIDENCE (load error)` |
| a run performed before the commit it is attributed to | `STALE CHECK` |
| a run in a different worktree | rejected by `cwd` match |
| a runner that ran but whose outcome is not in the log | `runner ran, outcome not in log`, never rounded up to a pass |
| a filename that merely appears in a `git diff` or `grep` command | rejected by runner detection (this one was a real bug: the first matcher accepted it as a run) |

A redirect to a file (`> out.log 2>&1`) is **not** a pipeline: the runner is still
the last command, so its exit status survives. An explicit `EXIT=n` echoed after
such a redirect is honoured.

A `NOT EVIDENCE (pipeline)` row means the exit status cannot be trusted. It does
**not** mean a suite failed; the output may well show a pass. It is weak
evidence, not a false green.

---

## Tooling

| File | Purpose |
|---|---|
| `trace.mjs` | the CLI |
| `lib/analyze.mjs` | pure analysis core, no I/O, so tests exercise the shipped path |
| `tests/` | the suite; `npm test` runs it |
| `tests/fixture-repo.mjs` | builds a throwaway git repository and Pi-shaped transcripts |
| `USAGE.md` | the workflow: where to stand, what to read first, every verdict |
| `FORMAT.md` | the feature-document shapes the parser reads, and the minimal contract that would complete the join |
| `FINDINGS.md` | **every measured number**, what it supports and what it does not |
| `probe.mjs` | explain why one commit's transcript entries were accepted or rejected |
| `coverage-report.mjs` | how many documents in a directory the join can read |
| `corpus-audit.mjs` | how much of the evidence chain resolves in a clone |
| `diagnose.mjs` | which documents still resist the parser, and the offending line |

```bash
npm test                              # the suite
node corpus-audit.mjs <dir> <repo>    # evidence-chain coverage
node coverage-report.mjs <dir>        # parser coverage
```

### Controls

A checker that only ever prints "missing" proves nothing, so the suite contains a
positive control and three negatives. Each builds its own repository and
transcript at run time and checks the verdict the tool must give:

| Test | Expected |
|---|---|
| positive control | `observed pass`, every spec covered |
| a pipeline's exit status | `NOT EVIDENCE (pipeline)` |
| a failing run | `observed fail` |
| a run before the commit | `STALE CHECK` |

---

## Findings

The measurements live in one place: [`FINDINGS.md`](FINDINGS.md). It states what
was measured (one repository, one commit), the results, what they support, what
they do **not** support, and a table of claims an earlier version of this project
made that later audits refuted.

In short: in the one corpus measured, a large share of the commits that feature
documents cite cannot be resolved from a plain clone, many task rows name no
commit at all, and most documents have no `## Log`. That is evidence the chain is
hard to follow, not evidence that work went unverified.

### A note on the review dimension

Native review authority is inventory-scoped: the ledger records candidate trees
and lineages, not ODD task ids. `attachReview` matches a lineage to a commit only
when the inventory names that commit, and otherwise reports `no match` or `none
recorded`. It never invents a mapping. Any finer link belongs inside the native
ledger.

---

## Relation to upstream work

- **`gentle-shell#554`** asks for a human-readable audit trail per lineage and
  executable evidence per finding. It lives *inside* native authority.
- **This tool is complementary**: it stays outside as a read-only join and never
  touches the ledger.
- **`gentle-shell#2366`** and **`#2369`** both note that harness effects are
  asserted rather than measured. `corpus-audit.mjs` is a small, concrete
  measurement of one such claim.
- **`gentle-shell#2408`** is the report these measurements produced: the minimal
  document contract (a commit and a check per task row), filed upstream with the
  reproduction.

## Status

Prototype. Not wired into any harness, no extension registered, nothing
persisted. It exists to answer one question with evidence: **does the join tell
you something you do not already know?** On the one corpus measured, the answer is
yes: the numbers in `FINDINGS.md` were not visible before the join existed. What
that means for any other project is for its own audit to say.

The feature-document shapes this tool reads, and the minimal contract that would
make the join complete, are in [`FORMAT.md`](FORMAT.md).
