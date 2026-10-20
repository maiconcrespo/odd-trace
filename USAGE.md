# How to use odd-trace

`odd-trace` is a **script you run by hand**, like `git` or `grep`. It is not
an extension, it has no TUI command, and nothing runs in the background. It
reads files, prints a table, exits. It never writes.

Nothing needs installing: Node 24 is enough, and it has no dependencies.

---

## 1. Where to stand

The script is at `gentletest/trace.mjs` and has no hard-coded paths, so it works
from anywhere:

```bash
node /path/to/odd-trace/trace.mjs --doc <file> [--repo <dir>]
```

`--repo` is the repository the feature document belongs to. **If you omit it,
the current directory is used.** So the natural workflow is: stand inside the
repository you are auditing.

```bash
cd /path/to/your-repo
node /path/to/odd-trace/trace.mjs --doc odd/tasks/<feature>.md
```

That is the whole invocation. `--repo` is only needed when you run from
somewhere else:

```bash
cd /tmp
node .../trace.mjs --doc /path/to/repo/odd/tasks/x.md \
                   --repo /path/to/repo
```

### Which directory is which

| Path | Meaning | If it is wrong |
|---|---|---|
| `--doc` | the ODD feature document (`odd/tasks/<name>.md`) | `feature document not found`, exit 2 |
| `--repo` | the git repository that document describes | `not a git repository`, exit 2 |
| `--sessions` | where Pi kept the transcripts | no runs found → `NO CHECK OBSERVED` |

`--doc` and `--repo` are usually in the **same** repository. `--sessions`
defaults to `~/.gentle-shell/agent/sessions`. If some of the work happened in a
worktree with a different `HOME`, add that home explicitly:

```bash
--sessions ~/.gentle-shell/agent/sessions,/other/home/.gentle-shell/agent/sessions
```

---

## 2. What to look at, in order

Read the output top to bottom. The first four lines tell you whether the run is
even meaningful.

```
feature  odd/tasks/yolo-temp-scratch-rm.md      ← the file it read
repo     /path/to/your-repo                     ← the repo it checked
specs 7   tasks 2   log 10   risk item 2 ...    ← what it parsed
sessions 1 root(s), 3520 observed run(s)        ← transcripts it loaded
```

### Check 0 — the document has a `## Specs` section

Some documents describe work without numbered requirements (`Goal`, `Why`,
`Locked decisions`, `Tasks`). They are legitimate, but there is nothing to join:
no `S#` exists to ask "was this verified?". The tool lists the tasks it found and
says so, rather than printing an empty table:

```
T#      commit   checks
T1      —        bullet
T2      —        bullet

no ## Specs section: 24 task(s) parsed, 0 requirements to join.
```

If you want per-requirement evidence from such a project, the document needs
`S#` ids. That is a documentation decision, not a tool limitation.

### Check 1 — `specs` and `tasks` are not zero

If either is `0`, the document is not in a shape the parser understands and
everything below is meaningless. The CLI now exits with status 3 and says so:

```
odd-trace: no specs and no tasks parsed from odd/tasks/x.md
  sections present: {"specs":false,"tasks":true,"log":false}
```

That means **the document uses a shape I have not seen yet** — send it over, it
is a parser bug, not a document bug.

### Check 2 — `sessions ... observed run(s)`

Zero observed runs means the transcripts were not found, or contain no bash
calls. Check the path before reading the table.

### Check 3 — the `verdict` column, one row per requirement

Each row is one `S#`. A spec with two commits gets two rows.

```
S#   T#   commit   check                         code   verdict
S1   T1   b8b1ba1  4 file(s), no run found       —      NO CHECK OBSERVED
S3   —    —        —                             —      NO TASK
S6   T2   7ff4157  1 run(s) predate the commit   —      STALE CHECK
```

| Column | What it means |
|---|---|
| `S#` | the requirement |
| `T#` | the task that claims it (`—` = no task claims it) |
| `commit` | the commit the document cites (`—` = the document cites none) |
| `check` | which test file was run |
| `code` | the observed outcome (`0`, `fail`, `piped`, `error`, `?`, `—`) |

### Check 4 — `spec coverage`

```
spec coverage: 0/7 specs have an observed passing check
```

This is the headline number: how many requirements have evidence, out of how
many exist.

---

## 3. Reading the verdicts

| Verdict | What actually happened | What to do |
|---|---|---|
| `observed pass` | a runner ran this commit's test file after the commit, all passed | nothing — this is what evidence looks like |
| `observed fail` | same, and it reported failures | the document claims done; the tests disagree |
| `NOT EVIDENCE (pipeline)` | the exit code came from `grep`/`head`, not the runner | the run proves nothing; re-run without a pipe |
| `NOT EVIDENCE (load error)` | the runner could not load; the test never ran | fix the environment, then re-run |
| `STALE CHECK` | the only runs are older than the commit | the evidence predates the change |
| `NO CHECK OBSERVED` | no transcript on this machine ran that test | the evidence is elsewhere, or was never recorded |
| `NO TASK` | the spec belongs to no task row | the document is incomplete |
| `NO COMMIT IN DOC` | the task row cites no commit | the document cannot be joined |
| `COMMIT MISSING` | the commit is not in this clone | it came from a worktree or rewritten history |
| `runner ran, outcome not in log` | a run happened; the transcript has no result | treat as unproven |

**The most common result on real documents is `NO CHECK OBSERVED`.** That is the
finding, not a failure of the tool: the work was verified somewhere this machine
cannot see, or nobody wrote down the commit.

---

## 4. Exit codes

| Code | Meaning |
|---|---|
| `0` | ran, at least one document was readable |
| `2` | bad usage: missing document, or `--repo` is not a git repository |
| `3` | the document parsed to nothing (no specs and no tasks) |

Exit codes make it scriptable:

```bash
node trace.mjs --doc odd/tasks/x.md || echo "could not read that document"
```

---

## 5. The other entry points

```bash
node --test tests/*.test.mjs                                   # 35 checks
node corpus-audit.mjs <odd/tasks> <repo>                       # whole-corpus audit
node coverage-report.mjs <odd/tasks>                           # parser coverage per directory
node diagnose.mjs <odd/tasks>                                  # which documents resist, and why
node probe.mjs <commit> <repo>                                 # why one commit's runs were accepted
```

---

## 6. Explaining it to someone else

> odd-trace cross-references three things that already exist: the specs in an
> ODD feature document, the commits that document cites, and the test runs
> recorded in Pi's transcripts. For each requirement it reports whether there is
> observable evidence that it was tested, in which commit, with what result.
>
> It is a script you invoke by hand. It is not an extension, it has no TUI
> command, and it runs nothing in the background. It is strictly read-only.
>
> Minimum usage: stand in the repository and run
> `node .../trace.mjs --doc odd/tasks/<name>.md`.
>
> It refuses to count as evidence: a pipeline whose exit code came from `grep`, a
> runner that failed to load, a run older than the commit, a run from another
> worktree, or an outcome the log does not contain. When there is no evidence it
> says there is no evidence.
