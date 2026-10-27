# Your first run

## Add a project

Choose **On this computer** in the sidebar and pick the folder of a Foundry project. Formal Mind can read only the
folders you add, and it uploads nothing. The folder's page opens with its files, and the chat is on the right.

Formal Mind works out what to verify from your **deploy scripts**. The contracts that scripts under `script/` deploy
or call, with their base contracts, are in scope. A project with no deploy script has no functions in scope, and the
swarm says so. Write a script that deploys the contracts you want audited, even a short one.

## Start the swarm

Type a focus in the chat if you have one ("the liquidation path first", "check the fee math"), or leave it empty,
then press **Start**. Set a spending cap if you run on your own key.

The first thing the swarm does is write the **plan**, `.formal/plan.md`: one line per function in scope, the
functions your scripts call first. Then it works through the plan one function at a time. The Canvas shows each agent
on the item it's working on, and the chat shows what it says and the tools it runs.

If the project has no Lean setup yet, the first prover creates one in `formal/`. The Lean model of each contract is
generated into `formal/Specs/`.

## While it runs

- **Talk to it.** Anything you type is answered before the next agent's turn. Ask what it's doing, change the
  focus, or add a [statement](/statements) to prove.
- **Stop and resume.** Stop any time, or quit the app. The work is a queue kept in `.formal/`, so the next start
  carries on with the same job, and nothing finished is redone.
- **Watch the results.** [Proofs](/proofs) fills in as functions are proved. [Bugs](/bugs) lists findings as they
  are filed.

Next: [how the swarm works](/swarm).
