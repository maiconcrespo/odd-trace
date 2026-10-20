# Testing this yourself

Everything here runs on Node 22+ with **no dependencies and no install step**.

```bash
git clone <this repo>
cd odd-trace
npm test
```

Expected: `35 pass / 0 fail`.

If a test fails on a fresh clone, that is a bug in this project, not in your
machine — the suite builds its own git repository and its own transcripts in a
temp directory and cleans them up. It never reads your checkout, your `HOME`,
or your Pi sessions.

## Try it on a real repository

```bash
cd /path/to/a/repo-with-odd/tasks
node /path/to/odd-trace/trace.mjs --doc odd/tasks/<name>.md
```

No flags are needed when you are standing in the repository. See
[`USAGE.md`](USAGE.md) for the full workflow.

## Check the whole corpus of a project

```bash
node corpus-audit.mjs /path/to/repo/odd/tasks /path/to/repo
```

It prints how many documents the join can read, how many commits they reference,
and how many of those commits actually exist in that clone.

## Why the numbers matter

`corpus-audit.mjs` measured 144 feature documents in a real repository and found
that 99 of the 184 commits they cite do not exist in the clone. That measurement
is filed upstream as
[gentle-shell#2408](https://github.com/Gentleman-Programming/gentle-shell/issues/2408),
together with the minimal document contract that would make the join complete.
If you run the audit on your own project and get a different picture, that is
worth reporting too.

## What to report

The most useful report is a document the parser gets wrong. Run:

```bash
node diagnose.mjs /path/to/odd/tasks
```

and include the offending line it prints. The parser accepts every shape found
in 144 real feature documents plus eight other projects (see `FORMAT.md`), so a
new shape is genuinely new information.

## Where the decisions live

| File | Read it for |
|---|---|
| `lib/analyze.mjs` | what counts as evidence, and every refusal to infer |
| `tests/analyze.test.mjs` | one test per rule, named after the rule |
| `tests/fixture-repo.mjs` | how a self-contained repository and transcript are built |
| `FORMAT.md` | the observed document format and the minimal contract that would complete the join |

## The one design rule

If you change something, keep this true: **the tool must never report a pass it
did not observe.** A pipeline whose exit status came from `grep`, a runner that
failed to load, a run older than the commit, a run from another worktree, or an
outcome absent from the log are all reported as what they are. No rounding up.
