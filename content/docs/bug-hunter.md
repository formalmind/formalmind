# The Bug Hunter

The **Concolic** view runs the Bug Hunter, one agent that works like an auditor on the compiled bytecode. It reads
the code, writes down specific suspicions, and uses the tools to prove or kill each one. Every bug it reports comes
with a passing Foundry PoC.

## Start a hunt

Open **Concolic** on a folder's page, type a focus ("the fee path", "`AsyncFiller.updatePrice`") or leave it empty,
and press **Start**. Without a focus it starts from the functions that move value or change who's in charge: swaps,
fills, withdrawals, admin setters.

It says what it's about to do and why before each step, and what a result showed after it. Each suspicion is tagged
on its line, so you see in your editor what it's chasing. Messages you send reach it at its next step.

## Its tools

- **Coverage.** Your Foundry suite, run on the bytecode solc produces with your project's settings (optimizer on: the
  code that ships), with every line and every branch side it reaches. Untaken sides are where bugs hide.
- **Concolic exploration.** For a branch side no test takes, it runs your fuzz tests with the inputs tracked
  symbolically and asks the z3 solver for inputs that take it. Inputs that make a test fail come back already
  reduced to the simplest that still fail. Needs `z3` installed.
- **The debugger.** It runs a test step by step in an EVM, with every opcode mapped to its Solidity line and storage
  named by variable. You can watch the agent's debugger while it works.
- **PoCs.** A suspicion that holds becomes a test under `test/formal/` that passes by showing the bug, then a finding
  in [Bugs](/bugs).

It doesn't change your contracts or your tests. A test that fails because the test itself is wrong isn't a bug, and
it says so.
