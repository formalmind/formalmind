# Models and costs

Your files, `lake` and `forge` all run on your computer. Only the agents' model calls leave it, by one route that you
pick in **Settings → Models**.

| Route | Who pays | Notes |
|---|---|---|
| **Claude Code (your Claude plan)** | your Claude Pro or Max plan | The default. Each agent turn runs the `claude` you installed and signed in to yourself. Nothing is charged to credits or a key; your plan's usage limits apply |
| **formal.team credits** | prepaid credits on your formal.team account | Metered per agent turn; every line shows in **Usage**. Buy credits in **Billing** ($10 to $1,000) |
| **Your Anthropic key** | your Anthropic account | Calls go straight to Anthropic. The key is kept in the system keychain |
| **Your OpenAI key** | your OpenAI account | The agents run on GPT-5 instead of Claude |

## On your Claude plan

The app runs Claude Code as it ships, with your own sign-in. It never sees or stores your Claude credentials, and it
clears `ANTHROPIC_API_KEY` for the run so your plan pays, not a key you happen to have set. Nothing from your own
Claude Code setup (settings, hooks, `CLAUDE.md`, skills, other MCP servers) reaches the agents. Settings shows what
`claude auth status` reports, and Start waits until Claude Code is signed in.

The chat's **Thinking** menu, beside the model, sets how hard the agents think (Claude Code's effort: low, medium or
high; Default leaves it to Claude Code). Lower is faster and uses less of your plan; it applies from the next agent turn.

Plan limits assume ordinary individual use, so a swarm left running for long will reach them. When it does, the
swarm pauses with its job saved. Start again after the limit resets.

## The spending cap

On credits or a key, each session has a cap, shown in the chat's header with what's been spent. The swarm stops
when it reaches the cap. Raise it from the header and resume to carry on.

## Formal Mind's report

Generating Formal Mind's report costs $150 from credits, once per repository and commit, whichever route runs the
agents. See [Bugs and reports](/bugs#formal-minds-report).
