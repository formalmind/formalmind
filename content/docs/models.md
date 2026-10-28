# Models and costs

Your files, `lake` and `forge` all run on your computer. Only the agents' model calls leave it, by one route that you
pick in **Settings → Models**.

| Route | Who pays | Notes |
|---|---|---|
| **Claude Code (your Claude plan)** | your Claude Pro or Max plan | The default. Each agent turn runs the `claude` you installed and signed in to yourself. Nothing is charged to a key; your plan's usage limits apply |
| **Codex (your ChatGPT plan)** | your ChatGPT Pro or Plus plan | Each agent turn runs the `codex` you installed and signed in to with ChatGPT. The agents run on GPT-6 Astra or GPT-5.6 (Sol, Terra, Luna). Nothing is charged to a key; your plan's Codex usage limits apply |
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

## On your ChatGPT plan

Codex works the same way. The app runs `codex exec` with your own ChatGPT sign-in and clears `OPENAI_API_KEY` for the
run, so your plan pays. Your Codex config, rules, skills and plugins don't reach the agents. Codex's own shell and
file tools are off, so the agents act only through Formal Mind's tools, as on the other routes. Settings shows what
`codex login status` reports. Start waits until Codex is signed in with ChatGPT. If it's signed in with an API key
instead, run `codex login` and pick Sign in with ChatGPT.

The **Thinking** menu sets Codex's reasoning effort. When a usage limit is reached, the swarm pauses with the job's
thread saved, and the next start resumes it.

## The spending cap

On your own key, each session has a cap, shown in the chat's header with what's been spent. The swarm stops
when it reaches the cap. Raise it from the header and resume to carry on.
