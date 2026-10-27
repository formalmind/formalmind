# Bugs and reports

The Bugs page gathers every finding about the folder: the swarm's and the ones in audit reports
you already have.

## Findings from the swarm

A finding is filed only with a proof-of-concept: a Foundry test under `test/formal/` that passes by showing the
problem. The swarm runs the test with `forge test --match-path` before it files anything. Each finding has its
scenario, impact and recommendation written as an audit report states them, its place in the code (file and line),
and its PoC.

Findings are written to your audit folder (`audit/`, or `audits/` or `reports/` if that's what you have):

- `formal-mind.audit.json`, Formal Mind's audit in [the audit format](/audit-format);
- `formal-mind-swarm.md`, the findings as Markdown;
- a row in the folder's index, `README.md`, with the finding's ID (`FM-01`…) and status.

## Audit reports you already have

Put a report (PDF or Markdown) in your audit folder and it shows in Bugs. Choose **Read findings** and the swarm's
auditor reads it: it records every finding in the report's own words, then checks each one against the current code
and sets its status:

| Status | Means |
|---|---|
| fixed | the issue is gone; the evidence says what changed and which test covers it |
| works as expected | intended behaviour, or not valid for this code |
| acknowledged | accepted, as the report or the code says |
| open | still there |

The result is a `.audit.json` file next to the report (`Spearbit.pdf` → `Spearbit.audit.json`). Other folders can be
added as audit folders in **Settings → Audit reports**.

## Formal Mind's report

As it works, the swarm writes its own report of the folder, `formal-mind.audit.json` in the audit folder:

- the swarm's findings, with their PoCs, evidence and fixes;
- the properties the reviewer approved, including proved [statements](/statements), with the theorems that prove
  them.

Bugs lists it, and its findings, apart from the other audit reports.
