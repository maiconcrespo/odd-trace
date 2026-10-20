# Findings

This is the **only** place in this repository that states measured numbers. The
other documents link here. If a number changes, it changes once.

## What was measured

| | |
|---|---|
| corpus | the `odd/tasks` directory of one repository (gentle-shell) |
| commit measured | `f58010c46` (2026-10-16) |
| clone | full, 6,281 commits |
| reproduce | `node corpus-audit.mjs <repo>/odd/tasks <repo>` |

The numbers describe **one repository at one commit**. They are not a statement
about ODD in general, and a different clone (or one that fetched more branches)
can give a different answer.

## Results

| | |
|---|---|
| feature documents | 144 |
| with a literal `## Specs` heading | 46 |
| with a literal `## Log` heading | 46 |
| with a literal `## Tasks` heading | 113 |
| with a `## Tasks <qualifier>` heading | 9 |
| **documents with any parsed spec** | **83** |
| &nbsp;&nbsp;specs written by the author (`S#` ids) | 307, in 46 documents |
| &nbsp;&nbsp;specs derived from a list (no ids) | 183, in 37 documents |
| documents with no parsed spec | 61 (36 of them have readable tasks) |
| **documents with readable task rows** | **117** |
| joinable (specs and tasks both readable) | 81 |
| tasks parsed | 532 |
| **commit references (counted per document)** | **175** |
| &nbsp;&nbsp;present in the clone | 95 |
| &nbsp;&nbsp;not present in the clone | 80 |
| **distinct commits** | **174** |
| &nbsp;&nbsp;not present in the clone | 79 |
| documents whose cited commits all resolve | 29 |
| documents with at least one unresolved commit | 20 |
| documents with task rows but no commit reference | 68 |
| documents with no `## Log` heading | 98 |

Cross-check: 29 + 20 + 68 = 117, the documents with readable task rows.

Why two commit units: a commit cited by two documents is two references but one
commit. The first answers "how often does a reader hit a dead link"; the second
answers "how many commits are unreachable".

## How requirements are read

A document can state requirements two ways, counted separately:

- **Written by the author**: a `## Specs` section with `S#` ids. 46 documents.
- **Derived from a list**: a `## Acceptance criteria` (or `## Requirements`)
  section with no ids. Each top-level item is numbered `S1…Sn` in document order
  and marked `derived: true`. 37 documents.

Derivation lets such documents be joined at all. It is a reading of the document,
not something its author wrote, so the two counts are never summed without
saying so.

**Precision of the derived specs.** I read up to the first three derived specs of
8 of the 37 documents (every fifth document, in file order): 23 specs, since one
document has only two. All 23 were verifiable statements. That is a sample of
about a fifth of the documents, not a guarantee; a section titled "Acceptance
criteria" can contain notes or examples as bullets.

## What the parser does not read

- **61 documents have no parsed spec.** Their requirement-like headings are
  `Objective` (23), `Scope and constraints` (12), `Constraints` (12), `Scope`
  (11) and similar. They were left unread on purpose: an objective or a
  constraint is not a verifiable requirement, and deriving specs from them would
  raise the count without adding information.
- **One document writes `## Acceptance criteria and constraints`**
  (`single-pr-delivery.md`). Its bullets mix criteria with restrictions, so
  numbering them `S1…S7` would present both as requirements.
- **Five documents have a `## Tasks` heading and yield no tasks.** Two use no
  ids at all (a plain numbered list, and bullets that cite `Evidence:`); three use
  ids the parser does not recognise (`SHELL-1`, `RELAY-1`, `ODD-GATE-1`). That is
  a limit of this parser, and it is why 113 documents have the heading but 108 of
  them produce tasks. Widening the id pattern would raise the task count a little;
  it was left alone to stop the parser growing one corpus quirk at a time.
- **A horizontal rule (`---`) does not end a section; only the next `## `
  heading does.** No document in the corpus contains one.

## What "not present" does and does not mean

A commit counts as *not present* when `git cat-file -e <sha>^{commit}` fails in
the clone, and no remote-tracking branch of that clone contains it. All 79
unresolved distinct commits were checked against `git branch -r --contains`; none
is on a fetched remote branch.

That is evidence the commit is not reachable **from this clone**. It is **not**
proof the commit never existed: it may live in an unfetched branch, a fork, a
worktree that was deleted, or history that was rewritten. Telling those apart
needs the original authors' machines, which this tool does not have.

A token is counted as a commit only if it is 7–12 hex characters or exactly 40,
and never a bare run of ten or more digits. The second rule was checked in the
other direction: of 45 distinct 10–12 digit tokens in the corpus, none resolves
to a commit, so the filter is not discarding real ones. One of the 79 unresolved
tokens is nine digits long; it sits in a list of abbreviated commits and is
counted as one.

## What these numbers support

1. **A large share of cited commits cannot be resolved from a plain clone.**
   79 of 174 distinct commits (45%).
2. **Many task rows name no commit.** 68 of the 117 documents with readable
   tasks (58%).
3. **Most documents have no `## Log`.** 98 of 144.
4. **Requirement coverage is not machine-readable by default.** Only 46 of 144
   documents have a `## Specs` heading, and the repository uses at least five
   spec shapes and three task-row shapes (see `FORMAT.md`).

## What these numbers do not support

- **That any requirement was not verified.** A requirement can be verified and
  recorded somewhere this tool cannot see. It measures whether evidence is
  *recoverable*, not whether work was *done*.
- **That anyone acted carelessly.** Missing links are what you expect when work
  happens in worktrees and the document is written afterwards.
- **A rate for other projects.** One corpus.

## Corrections to earlier claims

Earlier versions of this repository, and an upstream issue, stated figures and
claims that later audits of this project refuted. They are listed so the history
is honest.

| Earlier claim | What the audit found |
|---|---|
| "99 of 184 commits are missing" | 21 of those tokens were not commits: GitHub Actions run ids and native review lineage ids. After filtering, and after the parser learned to read more task sections, it is 79 of 174 distinct commits (80 of 175 per-document references). |
| "10 of 467 rows are a piped runner that already faked a green suite" | A `NOT EVIDENCE (pipeline)` row means the exit status cannot be trusted, **not** that a suite failed. The runs behind those rows printed `Tests 20 passed (20)`. They are weak evidence, not false greens. |
| the `yolo-mode.test.ts … \| grep ERR_MODULE_NOT_FOUND` transcript as an example of a faked green | It was a deliberate diagnostic: stash the change, grep for the module error to show the failure pre-dated it. It belonged to a different diff than the commit it was linked to. It shows that exit 0 says nothing about a suite, not that anyone trusted a broken one. |
| "each of these refusals was a real false positive found while building it" | Only one was: a `git diff` that merely mentioned a test file was accepted as a run. The pipeline and load-error rules are principles, and the example offered for them was the deliberate diagnostic above. |
| "all 144 documents have the required sections" | 46 have `## Specs`, 113 have `## Tasks` (122 counting a qualifier such as `## Tasks and routes`), 46 have `## Log`. |
| "49 documents have specs" | The parser read only numbered acceptance criteria. 34 more documents write them as bullets or checkboxes; the count is now 83. |
| "106 / 108 documents have readable tasks" | Nine documents head the section `## Tasks and routes`, `## Tasks and routing`, `## Tasks and acceptance` or `## Tasks / acceptance` and were read as having none. The count is now 117. |
| "a redirect to a file is a pipeline" | Wrong. A redirect leaves the runner as the last command, so `$?` is still its status. Only a pipe into a filter changes it. Fixed and tested. |
| "a horizontal rule now terminates a section" (a commit message) | Wrong, and its test passed for the wrong reason. The reader ends a section only at the next `## ` heading. The test was replaced by two that pin the real behaviour; the published commit message is left as it is. |
