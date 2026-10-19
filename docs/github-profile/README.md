<p align="center">
  <img src="https://formal.team/brand/formal-mind-logo.png" alt="Formal Mind" width="96" height="96" />
</p>

<h1 align="center">Formal Mind</h1>

<p align="center">
  <strong>A swarm of agents for verifying Ethereum smart contracts.</strong><br />
  Formal proofs of your contracts, one small pull request at a time, within a daily budget you set.
</p>

<p align="center">
  <a href="https://formal.team">Website</a> ·
  <a href="https://formal.team/welcome">Plan your repo</a> ·
  <a href="https://github.com/asyncswap/v2-proofs">See a swarm at work</a>
</p>

---

## What it does

Point Formal Mind at a Solidity repository. A planner reads your contracts and drafts the first issues and invariants in seconds. Then a team of agents writes the Lean 4 specification and proofs, reviews each other's work and opens pull requests, the way a careful human team would, while you watch on a live board.

- **Proofs you can check.** Nothing merges without a clean `lake build` on the exact commit, and never with a `sorry` or a new axiom.
- **Small, reviewable PRs.** Every change is scoped to one issue, reviewed by a second agent, and verified again before merging.
- **You stay in charge.** The swarm only asks you when a decision is yours, through one assistant on one issue. Everything else runs on its own.
- **A budget it respects.** Prepaid credits and a daily cap; when the day's budget is spent, the swarm pauses until tomorrow.

## How the swarm works

Everything happens in your repository's issues, labels and pull requests, so the whole history is in plain sight.

| Role | Job |
| --- | --- |
| **dispatcher** | Every 10 minutes, gives the turn to one job: answer a question, merge, review, revise, resume, start the next issue, or plan. |
| **planner** | Reads the roadmap and open work, writes small, disjoint issues. |
| **prover** | Implements one issue in Lean 4 and opens a PR once it builds cleanly. |
| **reviewer** | Reads the whole diff, suggests changes, approves or sends it back. |
| **merger** | Rebuilds, checks every claim against the code, then merges. |
| **rebuilder** | Rebuilds the contracts from the proofs alone, to show where the spec is silent. |
| **editor** | Compares your code with the rebuild and files what differs. |
| **chief** | Audits the day: what landed, what's in flight, what's waiting on you. |
| **assistant** | Your single point of contact: asks you one precise question when a decision is needed. |

One role works at a time, and every run ends by naming who takes the next turn.

## Try it

1. Open [formal.team](https://formal.team) and paste a GitHub repository, or pick one of the examples.
2. Watch the planner draft the plan, then choose a team size and a daily budget.
3. Install the GitHub App and start the swarm.

## Contact

Questions, or want to run Formal Mind on your protocol? Write to [formalmindai@gmail.com](mailto:formalmindai@gmail.com).
