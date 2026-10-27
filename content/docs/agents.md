# Agents and MCP

Formal Mind has two MCP servers on formal.team, so Claude, ChatGPT, Cursor or any MCP client can work with it.

## Connect your client

The account server, `https://formal.team/mcp/account`, acts on your own account. Add it once; the first time a tool
runs, it sends you to sign in with GitHub and asks you to allow the client.

- **Claude Code:** run the command below, then `/mcp` in a session to sign in.

  ```bash
  claude mcp add --transport http --scope user formalmind https://formal.team/mcp/account
  ```

- **Claude (claude.ai and the desktop app):** Settings → Connectors → **Add custom connector**, with that URL.
- **ChatGPT:** Settings → Connectors, turn on **Developer mode** (under Advanced), then **Create** a connector with
  that URL and OAuth.
- **Cursor:** add it to `~/.cursor/mcp.json`:

  ```json
  { "mcpServers": { "formalmind": { "url": "https://formal.team/mcp/account" } } }
  ```

Any other MCP client that speaks Streamable HTTP and OAuth works the same way.

## The account server

| Tools | Scope |
|---|---|
| `my_projects`, `my_usage`, `my_credits`, `swarm_state`, `list_files`, `read_file`, `list_audits`, `list_findings`, `get_finding`, `proofs_coverage`, `report_quote`, `mac_swarm`, `mac_swarm_events`, `mac_get`, `mac_reply` | `swarm:read` |
| `add_project`, `plan_repository`, `start_swarm`, `mac_swarm_send`, `mac_do` | `swarm:write` |

`mac_swarm` and `mac_swarm_events` show what the swarm on your Mac is doing, and `mac_swarm_send` sends it a message,
as if you'd typed it in the chat.

## Drive the Mac app

`mac_get` and `mac_do` let an agent do anything a folder's page in the app does, on your Mac, and get the answer back.
The app runs each one as if you'd clicked it there, with the model route and spending caps your Settings use.

- **`mac_get`** reads: the added folders, Claude Code's sign-in, a folder's files and git graph, the plan,
  statements, bugs, proofs, queue and sessions, a session's history, the scope from your deploy scripts, a contract's
  Lean coverage, a function's slice, Reach's map, what the report costs, the **work map**, and a function's **brief**.
- **`mac_do`** acts: add or remove a folder, start, **pause** or **resume** the swarm, start the Bug Hunter, send a session a message,
  set a cap, add, confirm, correct or mark statements, queue an audit report for triage, run a Reach tool, generate
  Formal Mind's report, **refresh the model**, and **check** and **submit** a proof.

Each tool's description lists its operations and their arguments. An answer that takes longer than about 50 seconds
(a report, say) comes back with an id; `mac_reply` fetches it. Your Mac has to be on, with the app running and signed
in and **Settings → Phone** on; no window needs to be open. Your tokens, keys, the terminal and the debugger stay out
of reach.

**`pause`** stops a session at once, including a long `lean` or `forge` run it's waiting on, and keeps its job;
**`resume`** carries on from the queue on your Claude plan (or whichever route Settings picks).

These are the same operations the app's own pages use: the app runs them in its background process, with the model
route and the caps from your Settings, whoever asks. Whatever an agent starts or stops shows on the folder's page at
once.

## Work on the proofs as a remote agent

Your own agent (Claude, ChatGPT, Cursor) can work through a folder's proofs alongside the swarm, through the same
checks and the same reviewer:

1. **`mac_get` `work_map`.** One JSON map of what's covered and what's left: every function in scope with its status
   (`proved`, `has_sorry`, `in_lean`, `not_modeled` and why), the Lean def a theorem has to name, the generated
   model, the file its proof goes in, the theorems that name it (file and line), its plan item, the open items to
   take next (the ones your scripts call first), and any model formal-ast could now translate more of.
   **`mac_get` `ledger`** says, for each function, whether it's proved and what's missing, with each theorem's
   statement as Lean prints it and its doc comment.
2. **`mac_get` `brief`** for a function: exactly what the swarm's prover gets, its def, its slice, and where to write.
3. **`mac_do` `check_proof`** with the file's path and content. It's written under the Lake sources' `Refinement/`
   and checked the way the swarm checks its own: no `sorry`, `admit`, new axioms or `native_decide`, `lake build`
   passes, and which functions the Proofs page now counts as proved. The answer has the build errors when it fails.
4. **`mac_do` `submit_proof`** sends it to the swarm's reviewer, like its own prover's work. Approved, the item is
   proved and goes into your audit file; otherwise the reviewer's notes come back in the session.

## Check the swarm is working

The app keeps a health line for every agent turn, in `turns.jsonl` in its log folder (`~/Library/Logs/Formal Mind`
on a Mac): the role and item, whether the agent's tools connected, how many tools it ran and how many `lake build`s
passed or failed, the context it used, how long it took and how it ended. Counts only: no code, prompts or agent
words, and it stays on your machine.

When a turn looks wrong, the session says so as it happens (**health:** in the chat): its tools didn't connect, it
wrote tool calls out as text instead of running them, it finished without running any tool, it called the same tool
with the same arguments again and again, or `lake build` kept failing. A turn whose tools didn't connect is stopped
and started again, twice, before the swarm pauses.

**`mac_get` `health`** reads it back: the newest turns, how they ended, and every anomaly, for one folder or all of
them. Ask it before trusting a long unattended run.

If a function is `in_lean` in the work map but its def isn't in the model file yet (formal-ast learned to translate it
after the file was written), **`mac_do` `refresh_model`** rewrites the model; `check_proof` does that first too.

## Local or GitHub

Every folder works locally unless you turn on **Report to GitHub** for it (Settings → GitHub, or `mac_do` `github`
with `{"on": true}`). Off, nothing reaches GitHub: no commits, pushes, issues or comments. On, Formal Mind's GitHub App
comments on that repository's pull requests with what the proof ledger says changed.

## The public server

`https://formal.team/mcp` needs no sign-in. It has three read-only tools: `get_audit_format` (the
[audit format](/audit-format)), `get_example_audit` (Formal Mind's audit of Async Swap's contracts) and
`get_app_release` (the app's latest version and downloads).

## Plan a repository without an account

```bash
curl -s https://formal.team/api/onboarding/plan -H 'content-type: application/json' -d '{"repo":"owner/name"}'
```

The planner reads a public repository and answers with what the swarm would verify first. It's limited to five plans
an hour per address, and a plan is cached for a week.

## For agents reading this

- Every page here is Markdown at its address with `.md` added, and [llms.txt](https://docs.formal.team/llms.txt)
  lists them.
- [formal.team/llms.txt](https://formal.team/llms.txt) and [llms-full.txt](https://formal.team/llms-full.txt) cover
  the API, both MCP servers and the agent skills.
- [auth.md](https://formal.team/auth.md) has OAuth registration, PKCE, tokens and scopes for clients that act on an
  account.
