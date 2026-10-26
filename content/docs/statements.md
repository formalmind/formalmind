# Statements

The plan proves what each function does. **Statements** are the claims you care about, written in plain words, for
the swarm to prove or disprove:

> Only the owner can change the fee recipient.
>
> `withdraw` reverts when the shares exceed the caller's balance.

They live in `.formal/statements.md`, next to the plan, and in the **Statements** list under the plan.

## Add one

Type it in the list's box ("State something about the code…"), or tell the assistant in the chat. You can also
write a line in `.formal/statements.md` yourself:

```markdown
- [ ] Only the owner can change the fee recipient.
```

The app gives it an id (`S-01`), and it keeps your words as you wrote them. Agents can propose statements too. Those
wait in the list with **Accept** and **Dismiss** until you decide.

If the swarm isn't running, adding a statement starts it just for the statements, and it stops when they're done. It
doesn't go on through the whole plan.

## How it's settled

1. **Formalize.** The assistant works out what the claim says about the code, reading the functions and the state
   they touch. It decides the kind of claim:
   - **function**: about one function (when it reverts, what it writes or returns);
   - **access**: who may change some state. The app finds every function that writes that state, from the syntax
     tree, so a writer the agent missed is still checked.
2. **Confirm.** The chat asks "is this what you meant?", with the claim restated in its own words, the functions it
   would be proved for, and the assumptions it made. Under the question are two or three replies it drafted for you:
   one that confirms, and one or two that correct the likeliest misreadings. Click one to put it in the message box,
   edit it if you like, and send. Or answer with **Yes** or **Edit** in the list.
3. **Prove.** Each function becomes its own proof job, through the same prove, check and review loop as the plan.
   The theorem is named for the statement (`S01.Morpho_setFeeRecipient`) and lives in
   `formal/Refinement/Statements/S01/`. The swarm checks that it exists under that name and has no `sorry`, and shows
   its type, as Lean prints it, to the reviewer.
4. **Record.** When every function is approved, the statement is proved and goes into your audit file as one
   property (`P-S01`): your words as its title, what it was confirmed to mean, and every theorem.

## Marks

| Mark | Means |
|---|---|
| `[ ]` | open: waiting to be formalized, or confirmed and waiting to be proved |
| `[?]` | waiting for you: a proposal to accept, or a formalization to confirm |
| `[~]` | working: some of its functions are proved |
| `[x]` | proved: every function it's about |
| `[!]` | disproved, or blocked after three tries |
| `[-]` | can't be proved against the generated model |

## Coming next

Claims across calls are formalized and recorded, but not proved yet: an **invariant** that always holds
("`totalSupply` equals the sum of balances"), **conservation** (what each call changes in total), and claims about
**sequences** of calls. Trying to disprove each statement with a fuzzer before proving it is planned as well.
