# The audit format

`formalmind.audit/v1` is one JSON file per audit report, kept next to it as `<name>.audit.json`. The Bugs page reads
it, the swarm writes it, and Formal Mind's own report uses it too. It's plain JSON, so other tools can read and write
it.

## Report

| Field | Type | |
|---|---|---|
| `schema` | `"formalmind.audit/v1"` | required |
| `kind` | `"external"` or `"internal"` | an audit firm's report, or Formal Mind's own |
| `title`, `auditor`, `authors`, `date` | strings (`date` as `YYYY-MM-DD`) | |
| `commit`, `repository` | strings | what was reviewed |
| `scope` | string[] | files in scope |
| `summary` | string | two sentences |
| `source` | string | the report file it was read from |
| `findings` | Finding[] | in the report's order |
| `coverage` | Coverage[] | internal: the Proofs coverage of each contract |
| `properties` | Property[] | internal: the properties proved and reviewed |

## Finding

| Field | Type | |
|---|---|---|
| `id` | string | the report's own ID (`H-01`, `M-2`…), unique in the file |
| `title` | string | |
| `severity` | `critical`, `high`, `medium`, `low`, `informational` or `gas` | as the report rates it |
| `status` | `open`, `fixed`, `acknowledged`, `works as expected` or `rejected` | where it stands in the current code |
| `reportStatus` | string | what the report itself said ("Fixed in PR #123") |
| `locations` | `{ file, line? }[]` | |
| `description` | Markdown | required |
| `impact`, `recommendation`, `response` | Markdown | |
| `evidence` | Markdown | why this status: what changed and the test that covers it |
| `tests` | string[] | regression tests |
| `poc` | string | a proof-of-concept test |
| `fix` | `{ commit?, pr?, url? }` | |
| `page` | number | where it starts in the source PDF |

## Coverage

| Field | Type | |
|---|---|---|
| `contract` | string | |
| `functions`, `inLean`, `proved`, `notModeled`, `theorems`, `sorry` | numbers | counted as the Proofs page counts them |
| `rows` | `{ function, status, theorems, why? }[]` | `status`: `proved`, `sorry`, `modeled` or `not modeled` |

## Property

| Field | Type | |
|---|---|---|
| `id` | string | `P-01`… for a plan item, `P-S01`… for a statement |
| `statement` | string | the statement's id, for a proved statement |
| `title` | string | the function, or the statement's words |
| `status` | `verified`, `sorry` or `unproved` | |
| `locations` | `{ file, line? }[]` | |
| `description` | Markdown | what was proved, and its assumptions; required |
| `theorems` | `{ name, file?, line?, sorry? }[]` | the theorems that prove it |
| `files` | string[] | the proof files |

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
      "evidence": "The check moved before the transfer (src/PoolManager.sol:118); test/PoolManager.t.sol covers it.",
      "tests": ["test/PoolManager.t.sol"],
      "page": 7
    }
  ]
}
```
