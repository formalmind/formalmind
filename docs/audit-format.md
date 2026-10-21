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
| `page` | number | where it starts in the source PDF |

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
