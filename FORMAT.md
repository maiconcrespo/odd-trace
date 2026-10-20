# ODD feature-document format, as observed

This is not a proposal. It is what the 144 real feature documents in one
repository's `odd/tasks` actually contain, measured by `corpus-audit.mjs`. The
counts are in [`FINDINGS.md`](FINDINGS.md); this file describes the shapes.

The ODD contract names four sections: header, `## Specs`, `## Tasks`, `## Log`.
Not every document has all four, and beneath the section names there is no
grammar, so the same repository uses all of the shapes below at once. Nobody is
at fault for that: the contract never specified more.

## Spec definitions

Five shapes occur under `## Specs`; the parser accepts all five.

```markdown
- **S1** text
- **S1 — Title.** text
S1 — Title. text                 ← no bullet, no bold
- S1 (user, verbatim): "..."     ← parenthetical tag instead of a title
- S#1 text                       ← hash inside the id
```

A line only counts as a definition when the id opens the line. `S3` used
mid-sentence is a cross-reference and is ignored.

### Requirements with no ids

Many documents have no `## Specs` at all and state requirements under
`## Acceptance criteria` (or `## Requirements`), as a numbered list, bullets or
checkboxes:

```markdown
## Acceptance criteria

- Selectorless inspect remains unchanged.
- [x] Invalid selector combinations fail before native mutation.
```

Each top-level item becomes one spec, numbered `S1…Sn` in document order and
marked `derived`. A wrapped continuation line or an indented sub-item belongs to
the item above it. If the same section also contains explicit `S#` ids, those
are kept as written and an unnumbered item skips any id the author already
used, so two requirements never share one id.

Two kinds of document are deliberately **not** read as having requirements:
those whose only requirement-like headings are `Objective`, `Scope` or
`Constraints` (not verifiable statements), and one whose heading is
`## Acceptance criteria and constraints` (its bullets mix both).

## Task rows

Three shapes, one table grammar.

**Table.** Column mapping is by header name, because headers vary:
`ID | Specs | Route | Commit`, `ID | Specs | Route | Status | Commit`,
`ID | Specs | Work | Route | Status`, `Unit | Intent | Candidate paths | …`.

Ids are not always `T#`: `N0`, `N1a` (phases) and `SN-2` (project-prefixed)
also occur.

**Bullet.**

```markdown
- T1 [x] S1-S7, S11 — work. Route: inline. Commit: `250cec03`
- [x] **SN-2 — Scheduler** | S7/S8/S12 | route: delegated worker | Commit LOCAL `0229cb`
```

**Prose.**

```markdown
T1 · S1,S2 · inline · test-first · **DONE RED→GREEN** — work
```

## Normalization the parser applies

- `S1-S7` and `S1,S2,S5` both expand to a set of ids; a range wider than 30 is
  not expanded (it is almost certainly a typo, not a real range).
- `SN-2` becomes `SN2` for matching; the document keeps its own spelling.
- A token is a commit only if it is 7–12 lowercase hex characters (an
  abbreviation) or exactly 40 (a full id), and never a bare run of ten or more
  digits. Documents also carry GitHub Actions run ids and native review lineage
  ids; counting those as commits once inflated the "missing commit" figure.
- A `## Tasks` heading may carry a qualifier (`## Tasks and routes`,
  `## Tasks and acceptance`, `## Tasks / acceptance`). The exact `## Tasks`
  heading is tried first and wins when both exist; a qualified one is the
  fallback. The qualifier must follow a space or a slash, so `## Taskset notes`
  is not a task section.
- If `## Tasks` yields no task rows (the heading is absent, or it holds only
  prose), a `## Status` checkbox list is read as tasks instead, numbered
  `T1…Tn`. A document whose `## Tasks` does yield rows never falls back.

## What the format does not carry

These gaps are why the join reports `—` rather than a value. How often each
occurs in one real corpus is in [`FINDINGS.md`](FINDINGS.md).

1. **Task rows often name no commit.** The task is described and marked done;
   there is no link to the work.
2. **Cited commits are often unreachable from a plain clone.** They may live in
   worktrees, forks or rewritten history, so a document can look fully evidenced
   and be unresolvable.
3. **Many documents have no `## Log`**, so the verbatim request and the
   corrections that shaped the work are not recoverable from the document.
4. **Review lineage is never recorded per task.** The native ledger is
   inventory-scoped; nothing in a feature document names a lineage.

## The minimal contract that would make the join complete

If the goal is machine-readable evidence, one row per task with these three
fields is enough, and every existing shape can carry them:

```markdown
| ID | Specs | Commit | Check |
|----|-------|--------|-------|
| T1 | S1-S7 | `250cec03` | `node --test tests/x.test.ts` |
```

Everything else — route, status, prose, log — can stay exactly as it is.
The only new requirement is that the commit and the check be written down in a
place a parser can find, rather than implied.
