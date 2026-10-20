# ODD feature-document format, as observed

This is not a proposal. It is what 144 real feature documents in
`gentle-shell/odd/tasks` actually contain, measured by `corpus-audit.mjs`.

The ODD contract names four sections: header, `## Specs`, `## Tasks`, `## Log`.
Every document follows that. **Nothing below is violated by anyone** — there is
simply no grammar beneath the section names, so the same repository uses all of
these shapes at once.

## What the corpus contains

| | count |
|---|---|
| documents | 144 |
| with `## Specs` | 46 |
| with readable task rows | 106 |
| joinable (both) | 46 |
| specs parsed | 307 |
| tasks parsed | 486 |
| commits referenced | 183 |
| commits present in the clone | 85 |
| commits missing from the clone | 98 |
| documents with tasks but no commit reference | 59 |
| documents whose commits all resolve | 23 |
| documents with at least one missing commit | 24 |

## Spec definitions

All five shapes occur; the parser accepts all five.

```markdown
- **S1** text
- **S1 — Title.** text
S1 — Title. text                 ← no bullet, no bold
- S1 (user, verbatim): "..."     ← parenthetical tag instead of a title
- S#1 text                       ← hash inside the id
```

A line only counts as a definition when the id opens the line. `S3` used
mid-sentence is a cross-reference and is ignored.

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
- A commit is any 7–40 character lowercase hex token. Prose that mentions an
  issue number does not become a commit by accident.

## What the format does not carry

These gaps are why the join reports `—` rather than a value:

1. **59 documents have tasks but no commit reference at all.** The task is
   described and marked done; there is no link to the work.
2. **98 of 183 referenced commits do not exist in the clone.** They came from
   worktrees or from history that was rewritten. A document can look fully
   evidenced and be unresolvable.
3. **98 of 144 documents have no `## Log` section**, so the verbatim user
   request and the corrections are not recoverable from the document.
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
