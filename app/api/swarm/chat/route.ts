import { streamText } from "ai";
import { openAIModelNames, type OpenAIModel } from "@/lib/llm";
import { openai } from "@/lib/openai";
import { getSwarmState } from "@/lib/swarm";
import { swarmTools } from "@/lib/tools/swarm-tools";

const SWARM_RULES = `The formalmind swarm owns the Lean 4 specification in the proofs repository and works the roadmap in its README, hands off, within a budget.
Roles (all post as formalmind[bot]; the bold word at the start of a comment names the role):
- dispatcher: not a model. Every 30 minutes, or when an fm: label changes, it sums the ledger and, if the budget allows, gives the turn to one job in this order: answer a question, merge, review, revise, resume, new issue, plan.
- planner: reads the roadmap, changelog and open work; writes small disjoint issues labelled fm:todo; re-scopes blocked ones; posts a digest on the ledger.
- prover: implements one issue on branch fm/issue-<n>, pushes as it goes, opens a PR labelled fm:review once lake build is clean, with a changelog entry. Also revises bounced PRs.
- reviewer: reads the issue and whole diff, leaves inline suggestions, then labels fm:approved (Next: merger) or fm:changes (Next: prover). Parks after 3 rounds.
- merger: lake build and sorry check on the exact head, verifies every claim in the thread against the code, then squash-merges, bounces, or holds for @mmsaki.
- chief: once a day at 23:40 UTC posts on issue #53 with a headline of Done, Working, Waiting on you, or Paused on budget.
Turns: exactly one role works at a time. Every run ends with a "**Next:** <role | @mmsaki | nobody> — why" line (also in its notebook note, parsed as note.next), naming who takes the turn.
Questions: anyone, a role or a human, can write "/ask <role> <question>" on an issue or PR; that adds the label fm:ask-<role>, and the dispatcher gives that role the next turn (before anything else) to answer. The asked role answers and hands back, or takes the job over when it is the better one to do it (e.g. the reviewer as the quality check), following its own role's rules. At most three answers per item per day, then the item is parked. Nobody writes @fm-<role>: those handles are not the swarm's (@fm-chief is a stranger's account). If the user wants to talk to an agent, tell them to comment "/ask <role> ..." on the issue or PR.
Labels: fm:todo, fm:in-progress, fm:blocked (needs a human), fm:review, fm:changes, fm:needs-rebase, fm:approved, fm:human-ok, fm:ask-<role>.
Budget: $5/day, $150/month. Caps per run: plan, review and merge $0.40, prove $1.20.
Issue #38 is the ledger (costs and digests), #55 the notebook (one task list per run), #53 chief updates.`;

export async function POST(request: Request) {
	if (!process.env.OPENAI_API_KEY) {
		return new Response("Chat is not configured. Set OPENAI_API_KEY in .env.local to enable responses.", { status: 503 });
	}
	const { messages, model: requested } = await request.json();
	const model: OpenAIModel = openAIModelNames.includes(requested) ? requested : "gpt-6-luna";

	let state: string;
	try {
		state = JSON.stringify(await getSwarmState());
	} catch (error) {
		console.error("[swarm] state fetch failed:", error);
		state = "unavailable: the GitHub API request failed";
	}

	const result = streamText({
		model: model.startsWith("gpt-6") ? openai.responses(model) : openai(model),
		system: `You answer questions about what the formalmind swarm agents are doing. Be concise and concrete: name issue and PR numbers, labels, roles and dollar amounts. Answer only from the live state below; if it does not say, say so. "work" (open items and their current labels) and "merged" are the present truth. Comments in "chief", "notebook" and "ledger" are history with timestamps: when an older comment disagrees with the current labels or the merged list, trust the current state and mention that the comment is out of date. Today is ${new Date().toISOString().slice(0, 10)} (UTC). Link issues as https://github.com/<repo>/issues/<n>.
When the live state is not enough, use the tools to read an issue or PR thread, the files a PR changed, a run's steps, a file in the repository (README.md holds the decisions and roadmap, FORMAL_MIND.md the changelog), or to search issues. Prefer looking it up over guessing, and cite what you read.

${SWARM_RULES}

Live state (JSON, fetched just now):
${state}`,
		messages,
		tools: swarmTools,
		maxSteps: 6,
	});

	return result.toDataStreamResponse({
		getErrorMessage: (error) => {
			console.error("[swarm] model request failed:", error);
			return error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "The model request failed.";
		},
	});
}
