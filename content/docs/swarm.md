# The swarm

The swarm is a small team of agents, each with one role, working through your project one function at a time. Each
function goes through the same loop.

## The plan

`.formal/plan.md` is a checklist, written by the swarm itself from the compiler's syntax tree: one item per function
in scope. The functions your deploy scripts call come first, then the ones that write storage, then the rest.

```markdown
- [ ] `Router.matchBook` — Router (src/Router.sol:228): nonpayable · writes [orders] · guards 3 · external calls 1
```

| Mark | Means |
|---|---|
| `[ ]` | to do |
| `[x]` | proved, and approved by the reviewer |
| `[!]` | blocked after three tries, or a bug was found |

Each start adds the functions the plan doesn't list yet. Functions the Proofs page already shows as proved come
checked.

A tick doesn't stay just because it was given once. When a contract's code changes, the swarm regenerates its model
and Lean checks the proofs again. Any checked function that no longer counts as proved goes back to `[ ]`, with the
reason in the chat ("reopened `Pool.fee`: …"), and is proved again against the new code. Only theorems in the folder
Lake builds count (formalmind.toml's `sources`, or the lakefile's `srcDir`). A stray copy of `Specs/` or
`Proofs/` elsewhere in the repository proves nothing: the planner names it in the chat, and the agents can't read,
write or check files in it. A Lake project in a subfolder (say `validation/lean/`) is found there.

To have functions proved again yourself, say so in the chat ("reprove `AsyncSwap.useNonce`"): the swarm reopens those
items and carries on with the plan, even when your message arrives as a run is finishing.

## One function, start to finish

1. **The prover** takes the next open item. It gets a brief built from the syntax tree: the function's generated
   Lean definition, its guards, the storage it reads and writes, and its callees. It writes a proof of what the
   function does (when it reverts, what it writes, what it returns or sends) in
   `formal/Proofs/Functions/<Contract><Function>.lean`, and checks it with `lake build`.
2. **The swarm checks the proof** before anyone reviews it: no `sorry`, `admit`, new axioms or `native_decide`,
   `lake build` passes, and the Proofs page now counts the function as proved. If not, the prover gets the output
   back. After three tries the item is marked `[!]`.
3. **The reviewer** reads the proof against the Solidity: does the theorem say what the code does, about the
   generated definition itself? Approve marks the item `[x]` and writes the property into your audit file. Changes
   send it back to the prover with notes.
4. **If the property is false**, it's a bug. The prover writes a Foundry test under `test/formal/` that shows it,
   the swarm runs the test, and the finding is filed (see [Bugs](/bugs)). The item is marked `[!]` and the swarm
   moves on.

Your messages come first: the **assistant** answers anything you type before the next turn, and can change the plan
or add a [statement](/statements). A chat started with a message answers it and stops; ask for work ("prove the functions left") and the assistant
sets the swarm going on the plan after its answer. Start with no message to run the plan straight away.

While the agents work, the chat's input steers them. **Enter** queues what you typed for the agent's next step; the
note waits above the input until it is picked up. **⌘ Enter**, or **Now** on a queued note, stops the session and starts
it again on your note. When several agents work at once, the chat shows them as a tree under the swarm: pick one to
see its steps.

## Sessions, stopping and the cap

Each folder has one continuous session. Its work is a queue on disk (`.formal/queue.json`), and every agent's
conversation is saved as it goes. Quit at any point: the next start resumes the interrupted job where it stopped,
your unanswered messages are still waiting, and finished work is never redone.

On your own key, the swarm stops when it reaches the spending cap shown in the chat's header. Raise it and
resume to carry on. On your Claude plan nothing is charged, and your plan's usage limits apply instead (see
[Models and costs](/models)).

## What it never does

The swarm's state is your folder's: the plan and progress in `.formal/`, proofs in `formal/`, findings in your audit
folder with their tests under `test/`. It opens no issues or pull requests and pushes nothing. Its tools can't run
git, and its shell is limited to `lake` and `forge`.

## Skills

**Settings → Skills** lists free auditing checklists by other authors, such as Pashov Audit Group's hacking lenses
(MIT) and the Web3 Audit Corpus's vulnerability classes (CC BY 4.0). **Add** copies one into `~/.formalmind/skills/` for every project, pinned to a commit of its source with a
`SOURCE.md` for the attribution. The agents whose work it fits then read it: the reviewer before a verdict, the prover when it looks
for what could break, and the assistant in the chat. Nothing in a skill runs, and the swarm's own checks still decide.

To audit from the chat, ask the assistant: "audit `Lending.liquidate` with the lenses". Each real issue it finds comes
with a Foundry PoC and lands on the Bugs page, naming the lens that led to it.

In the chat, skills work as they do in Claude Code: `/skills` lists them, `/skills add <id>` and `/skills remove <id>`
add or remove one for every project, and `/<id> <request>` asks the agents to use it, as in
`/pashov-lenses audit Lending.liquidate`.
