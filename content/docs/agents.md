# Agents and MCP

Formal Mind has two MCP servers on formal.team, so Claude, ChatGPT, Cursor or any MCP client can work with it.

## The account server

`https://formal.team/mcp/account` acts on your own account. Add it as a connector in your client; the first time,
it sends you to sign in with GitHub and asks you to allow the client.

| Tools | Scope |
|---|---|
| `my_projects`, `my_usage`, `my_credits`, `swarm_state`, `list_files`, `read_file`, `list_audits`, `list_findings`, `get_finding`, `proofs_coverage`, `report_quote`, `mac_swarm`, `mac_swarm_events` | `swarm:read` |
| `add_project`, `plan_repository`, `start_swarm`, `mac_swarm_send` | `swarm:write` |

`mac_swarm` and `mac_swarm_events` show what the swarm on your Mac is doing, and `mac_swarm_send` sends it a message,
as if you'd typed it in the chat.

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
