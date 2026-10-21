# The audit format (`formalmind.audit/v1`)

One JSON file per audit report, kept next to it as `<name>.audit.json`
(`docs/audits/Spearbit.pdf` → `docs/audits/Spearbit.audit.json`). It is the single source of truth for a report's
findings:

- **External audits** (a PDF or Markdown report from an audit firm): the swarm's auditor reads the report (Bugs →
  *Read findings*) and writes this file: the report's facts, every finding in the report's words, and each finding's
  status checked against the current code.
- **Internal audits** (Formal Mind's own): written directly in this format, then rendered to a PDF by
  [audit-report-generator](https://github.com/mmsaki/audit-report-generator) when a polished report is wanted.
- **The app** (the Bugs page) reads only this format, plus the legacy `| ID | Severity | Finding | Status | Evidence |`
  tables in a report folder's `README.md`.

Types: [`lib/audit-format.ts`](../lib/audit-format.ts). Writers: `record_report` and `record_finding_json` in
`desktop/src-tauri/src/swarm_ctx.rs`.

## Report

| Field | Type | |
|---|---|---|
| `schema` | `"formalmind.audit/v1"` | required |
| `kind` | `"external"` \| `"internal"` | who wrote the audit |
| `title` | string | e.g. "Uniswap v4-core Security Review" |
| `auditor` | string | the firm or person |
| `authors` | string[] | |
| `date` | `YYYY-MM-DD` | |
| `commit`, `repository` | string | what was reviewed |
| `scope` | string[] | files in scope, repository paths |
| `summary` | string | two sentences |
| `source` | string | the report file it was read from, folder-relative (absent for an internal audit) |
| `findings` | Finding[] | in the report's order |
| `coverage` | Coverage[] | internal audits: the Proofs coverage of each contract in scope |
| `properties` | Property[] | internal audits: the properties proved and reviewed |
| `rebuild` | Rebuild | internal audits: the rebuild cycle (the contracts rebuilt from the proofs alone, compared with the code) |

## Finding

| Field | Type | |
|---|---|---|
| `id` | string | the report's own ID (`H-01`, `M-2`…); `F-01`… when it has none. Unique in the file. |
| `title` | string | |
| `severity` | `critical` \| `high` \| `medium` \| `low` \| `informational` \| `gas` | as the report rates it |
| `status` | `open` \| `fixed` \| `acknowledged` \| `works as expected` \| `rejected` | where it stands **in the current code** |
| `reportStatus` | string | what the report itself said ("Fixed in PR #123") |
| `locations` | `{ file, line? }[]` | repository paths |
| `description` | string (Markdown) | required |
| `impact`, `recommendation` | string (Markdown) | |
| `response` | string (Markdown) | the team's response in the report |
| `evidence` | string (Markdown) | why this status: what changed (file:line) and the test that covers it |
| `tests` | string[] | regression tests, e.g. `test/security/X.t.sol` |
| `poc` | string | a proof-of-concept test |
| `fix` | `{ commit?, pr?, url? }` | the fix: its commit, its pull request number, and a link to whichever is known |
| `page` | number | where it starts in the source PDF |

## Coverage

| Field | Type | |
|---|---|---|
| `contract` | string | |
| `functions`, `inLean`, `proved`, `notModeled`, `theorems`, `sorry` | number | counted as the Proofs page counts them (library functions included) |
| `rows` | `{ function, status, theorems, why? }[]` | `status`: `proved` \| `sorry` \| `modeled` \| `not modeled`; `theorems`: the names naming it; `why`: why it isn't modeled |

## Property

| Field | Type | |
|---|---|---|
| `id` | string | `P-01`… |
| `title` | string | the function or invariant |
| `status` | `verified` \| `sorry` \| `unproved` | |
| `locations` | `{ file, line? }[]` | |
| `description` | string (Markdown) | what was proved, required |
| `theorems` | `{ name, file?, line?, sorry? }[]` | the theorems that prove it, each where it is |
| `files` | string[] | the proof files |

## Rebuild

The rebuild cycle's state and findings, written by the local swarm as it works (`sync_rebuild` and
`record_difference` in `desktop/src-tauri/src/swarm_ctx.rs`). Its rebuilder writes the contracts again under
`rebuild/` from the Lean proofs and the generated model alone, never reading the code; its editor compares the two.

| Field | Type | |
|---|---|---|
| `cycle` | number | the current cycle, from 1 |
| `phase` | `rebuild` \| `compare` \| `polish` \| `close` \| `rest` | |
| `contracts` | `{ contract, draft, rebuild, state }[]` | `draft`: the code's file; `rebuild`: the rebuild's files; `state`: `queued` \| `rebuilt` \| `polish` \| `agreed` \| `compared` \| `blocked` |
| `tests` | string[] | the rebuild's tests (`rebuild/test/…`) |
| `undetermined` | string[] | what the proofs did not determine: the rebuilder's own list of the choices the spec left open |
| `summary`, `confidence` | string, `low` \| `medium` \| `high` | the last closed cycle's summary |
| `differences` | Difference[] | every cycle's |

## Difference

| Field | Type | |
|---|---|---|
| `id` | string | `D-01`…, unique in the file |
| `cycle` | number | the cycle that found it |
| `contract` | string | |
| `class` | `gap` \| `improvement` \| `divergence` \| `bug` | **gap**: the code does something the spec doesn't state; **improvement**: the rebuild is simpler or safer and still satisfies the spec; **divergence**: neither is clearly right; **bug**: one side breaks a theorem or an invariant |
| `status` | `open` \| `asked` \| `fixing` \| `decided` \| `closed` | `asked`: a question with the maintainer; `fixing`: sent to the rebuilder |
| `title` | string | |
| `description` | string (Markdown) | required |
| `draft`, `rebuild` | `{ file, line? }[]` | where in the code, and in the rebuild |
| `theorem` | string | a gap: the theorem the spec is missing; otherwise the Lean it bears on |
| `fix` | string | a gap, or a bug in the rebuild: what the rebuild should do, citing the Lean |
| `question`, `recommendation` | string | an improvement or a divergence: the question put to the maintainer |
| `decision` | string | the maintainer's answer |
| `finding` | string | a bug in the code: the finding's `id` in this file |

## Example

```json
{
  "schema": "formalmind.audit/v1",
  "kind": "external",
  "title": "Uniswap v4-core Security Review",
  "auditor": "Spearbit",
  "date": "2024-05-01",
  "commit": "a1b2c3d",
  "source": "docs/security/audits/DRAFT_Spearbit_audit_core.pdf",
  "findings": [
    {
      "id": "H-1",
      "title": "…",
      "severity": "high",
      "status": "fixed",
      "reportStatus": "Fixed in PR #123",
      "locations": [{ "file": "src/PoolManager.sol", "line": 120 }],
      "description": "…",
      "recommendation": "…",
      "evidence": "The check moved before the transfer (src/PoolManager.sol:118); `test/PoolManager.t.sol` covers it.",
      "tests": ["test/PoolManager.t.sol"],
      "page": 7
    }
  ]
}
```
