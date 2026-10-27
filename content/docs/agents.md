# Agents and MCP

Formal Mind has two MCP servers on formal.team, so Claude, ChatGPT, Cursor or any MCP client can work with it.

## The account server

`https://formal.team/mcp/account` acts on your own account. Add it as a connector in your client; the first time,
it sends you to sign in with GitHub and asks you to allow the client.

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
  Lean coverage, a function's brief, Reach's map, and what the report costs.
- **`mac_do`** acts: add or remove a folder, start or stop the swarm, start the Bug Hunter, send a session a message,
  set a cap, add, confirm, correct or mark statements, queue an audit report for triage, run a Reach tool, and
  generate Formal Mind's report.

Each tool's description lists its operations and their arguments. An answer that takes longer than about 50 seconds
(a report, say) comes back with an id; `mac_reply` fetches it. Your Mac has to be on, with the app signed in and
**Settings → Phone** on. Your tokens, keys, the terminal and the debugger stay out of reach.

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
