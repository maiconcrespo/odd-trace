# gentle-trace (prototype)

A read-only join over evidence that gentle-shell already produces but never
connects:

```
S# (spec) -> T# (task) -> commit -> observed check run -> review authority
```

It emits no verdict, approves nothing, writes nothing, and never replaces the
native reviewer. It reports what was observed, and where the chain is missing.

## Why

gentle-shell already records every ingredient separately:

| Ingredient | Produced by | Where |
|---|---|---|
| `S#` specs, `T#` tasks | ODD feature document | `odd/tasks/<feature>.md` |
| commits per task | work-unit commits | `## Tasks` table |
| check runs and their outcome | Pi session transcripts | `~/.gentle-shell/agent/sessions/` |
| review authority | native `gentle-ai review` | `review status` |

Nothing joins them. Today the join is prose written by hand:

```
- [x] Merge ... Evidence: `f6e6d93c`.
```

That is the only link that exists, and it depends on someone remembering to
write it. When a feature is resumed, or when someone asks "was this requirement
actually verified?", the answer is markdown archaeology plus trust.

## Usage

```bash
node trace.mjs --doc <feature.md> --repo <repo> \
  [--sessions <dir>] [--gentle-ai <binary>]
```

Sample against a real feature document in the gentle-shell repository:

```
S#   T#   commit   check                    code  verdict
S1   T1   b8b1ba1  4 file(s), no run found  —     NO CHECK OBSERVED
S3   —    —        —                        —     NO TASK
S6   T2   7ff4157  yolo-mode.test.ts        ?     STALE CHECK
```

## What it refuses to do

These are the interesting decisions, not limitations:

1. **A pipeline is not evidence.** `node --test x.test.ts | grep Error` exits
   with *grep's* status. A failing suite piped into `grep -m2 Error` looks like
   success. Such runs are reported as `NOT EVIDENCE (pipeline)`.
2. **A load error is not a test result.** `ERR_MODULE_NOT_FOUND` means the
   runner never reached the tests.
3. **A run before the commit says nothing about the commit.** Reported as
   `STALE CHECK`.
4. **A run in another worktree is not this repository's run.** Transcripts
   declare their `cwd`; mismatches are rejected. (This was a real false positive
   during development: a `git diff` command that merely *mentioned* a test file
   was initially accepted as a test run.)
5. **`?` stays `?`.** If the runner ran but the transcript does not contain the
   outcome, it says so. It never rounds up to a pass.

## Controls

The prototype ships with a positive control and three negative controls, because
a checker that only ever prints "missing" proves nothing.

| Fixture | Expected |
|---|---|
| `fixture/sessions` | `observed pass`, 2/2 specs covered |
| `fixture/neg-pipeline` | `NOT EVIDENCE (pipeline)` |
| `fixture/neg-fail` | `observed fail` |
| `fixture/neg-stale` | `STALE CHECK` |

`probe.mjs <commit> [repo]` explains, for one commit, why each candidate
transcript entry was accepted or rejected.

## What the prototype found

1. **Real verification runs are not in the transcripts.** The `yolo-temp-scratch`
   and `guard-compound-rm` work was executed in the
   `/home/gentleman/work/...` worktrees. Those transcripts live in a different
   Pi home, so on this machine zero verification runs for those commits exist.
   The feature documents assert "done, verified (L7)", and the harness has no
   record to check that against.
2. **A `?` outcome is common and dangerous.** When a run is piped into
   `grep`/`head`, the transcript keeps filter output, not the suite summary. The
   command exited 0 and the tests never passed.
3. **`S#` coverage is not tracked anywhere.** `S3` and `S4` in
   `yolo-temp-scratch-rm.md` ("unchanged behavior", "docs") belong to no task
   row. The document is satisfying the format while leaving specs unowned.
4. **`## Tasks` arity varies.** The parser must map columns by header name; four
   columns and five columns both occur in the same repository.

## Status

Prototype only. Not wired into gentle-shell, no extension registered, no data
persisted. It exists to answer one question with evidence: does the join tell
you something you do not already know? Findings 1-3 say yes.

Related upstream work: `Gentleman-Programming/gentle-shell#554` asks for a
human-readable audit trail per lineage and executable evidence per finding. It
lives *inside* native authority. This prototype is complementary: it stays
outside as a read-only join and never touches the ledger.
