# Files in your project

Formal Mind keeps everything in your folder, as ordinary files you can read, edit and commit.

## What it reads

- **Your Solidity**, through the compiler: solc's syntax tree for the contracts your scripts under `script/` deploy
  or call, and their bases. Agents never list or grep the sources; they read the functions through the tree.
- **`foundry.toml`**: your compiler settings and remappings, so the bytecode it tests is the bytecode that ships.
- **Your tests** under `test/`: the Bug Hunter's coverage and exploration run them, and PoCs reuse their setup.
- **Your audit folder**: `audit/`, `audits/` or `reports/`, plus any folder you add in **Settings → Audit reports**.

## What it writes

| Path | What |
|---|---|
| `formalmind.toml` | where the Lean proofs live (`[lean]` `project`: the Lake project, `sources`: where Lake reads `Specs/` and `Proofs/`), written at the first start when there's a Lake project; edit it if yours lives elsewhere |
| `.formal/plan.md` | the plan: one item per function, with its mark |
| `.formal/statements.md` | your [statements](/statements) and how far each has got |
| `.formal/queue.json` | the swarm's queue of jobs, so a quit resumes where it stopped |
| `.formal/run.lock` | which app's swarm is working in the folder, so a second copy of the app can't run it at the same time |
| `.formal/jobs/` | each job's full agent conversation |
| `.formal/runs/` | every session's event log, one JSON line per event |
| `.formal/proofs.json`, `.formal/statements.json` | which files and theorems proved each item |
| `.formal/ledger.json` | the proof ledger: what Lean checked for each theorem and the reviewer's approvals, by def ([Proofs](/proofs#the-ledger)) |
| `.formal/bugs/` | findings, one Markdown file each |
| `.formal/findings.sarif` | suspicions and notes on lines, which editors with SARIF support show inline |
| `formal/` | the Lean project (or wherever `formalmind.toml` says): `Specs/` (the model of each contract, rewritten when formal-ast can translate more of it), `Proofs/Swarm/` (proofs of the plan's items), `Proofs/Statements/` (proofs of statements). A folder with no Lake project gets one with these two libraries; a project set up before they were named this way keeps `Generated/` and `Refinement/` |
| `test/formal/` | proof-of-concept tests for findings |
| your audit folder | `formal-mind.audit.json`, `formal-mind-swarm.md`, the index's rows, and `.audit.json` files read from reports |

Commit what you want to keep. `.formal/` is safe to delete: the plan is rebuilt from the code, though the queue,
logs and statements go with it.

## What it never touches

It doesn't change your contracts or your existing tests, and it doesn't run git: no commits, branches or pushes.
Nothing is posted to GitHub.
