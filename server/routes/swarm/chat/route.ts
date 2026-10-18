import { streamText } from "ai";
import { openAIModelNames, type OpenAIModel } from "@/lib/llm";
import { openai } from "@/lib/openai";
import { auth } from "@/lib/auth";
import { LIVE_PROJECT, listProjects } from "@/lib/projects";
import { getSwarmState, SWARM_REPO } from "@/lib/swarm";
import { swarmTools } from "@/lib/tools/swarm-tools";

export const SWARM_RULES = `The formalmind swarm owns the Lean 4 specification in the proofs repository and works the roadmap in its .formal/plan.md, hands off, within a budget.
Roles (all post as formalmind[bot]; the bold word at the start of a comment names the role):
- dispatcher: not a model. Every 30 minutes, or when an fm: label changes, it sums the ledger and, if the budget allows, gives the turn to one job in this order: answer a question (the assistant's first), merge, review, revise, resume, the oldest queued issue (fm:todo or fm:rebuild), the editor when something it compares moved, plan.
- planner: reads the roadmap, changelog and open work; writes small disjoint issues labelled fm:todo; re-scopes blocked ones; posts a digest on the ledger.
- prover: implements one issue on branch fm/issue-<n>, pushes as it goes, opens a PR labelled fm:review once lake build is clean, with a changelog entry. Also revises bounced PRs.
- rebuilder: builds rebuild/, a polished, simplified Solidity implementation, from the proofs alone; it never sees the maintainer's draft (asyncswap/v2), so every guess it lists in rebuild/README.md shows where the proofs are silent. Works fm:rebuild issues on branch fm/rebuild-<n>, writes tests named after theorems and invariant tests, including ones no theorem states yet (each also an fm:finding).
- reviewer: reads the issue and whole diff, leaves inline suggestions, then labels fm:approved (Next: merger) or fm:changes (Next: prover). Parks after 3 rounds.
- merger: lake build and sorry check on the exact head, verifies every claim in the thread against the code, then squash-merges, bounces, or holds it for the maintainer (through the assistant). For rebuild PRs the gate also runs forge build and forge test.
- editor: runs the rebuild cycle. Compares the draft, the rebuild and the proofs, classifies each difference (gap, improvement, divergence, bug), files fm:finding and fm:rebuild issues, puts decisions to the maintainer through the assistant, moves the phase, and closes each cycle with a confidence (low, medium, high).
- chief: once a day at 23:40 UTC audits the day on issue #53 (headline Done, Working, Waiting on you, or Paused on budget). It no longer tags the maintainer.
- assistant: the maintainer's personal agent and the only role that talks to them, on issue #69. Other roles ask it with "/ask assistant"; it answers from recorded decisions when it can, otherwise asks the maintainer one precise question with a recommendation. Anything the maintainer writes on #69 wakes it, and it carries the answer out (unblock, labels, fm:human-ok, new issues, fm:intent for behaviour described in words). It never merges, pushes or edits files. At 23:50 UTC it posts the evening update.
Rebuild cycle (.github/formalmind/cycle.md, state in the "cycle" field): spec (formalize the draft and intents) → rebuild (from the proofs alone) → compare (editor: draft vs rebuild) → polish (fix, prove findings, re-compare) → reprove (write S′ under RebuildSpec/ from the rebuild and compare it with S) → close (summary and confidence). Two to five cycles, until draft and rebuild agree, the two specs agree, the last cycle found nothing new and no question is open. A behavioural draft commit or a new fm:intent restarts it.
Turns: exactly one role works at a time. Every run ends with a "**Next:** <role | nobody> — why" line (a decision for the maintainer is "Next: assistant") (also in its notebook note, parsed as note.next), naming who takes the turn.
Questions: anyone, a role or a human, can write "/ask <role> <question>" on an issue or PR; that adds the label fm:ask-<role>, and the dispatcher gives that role the next turn (before anything else) to answer. The asked role answers and hands back, or takes the job over when it is the better one to do it (e.g. the reviewer as the quality check), following its own role's rules. At most three answers per item per day, then the item is parked. Nobody writes @fm-<role>: those handles are not the swarm's (@fm-chief is a stranger's account). If the user wants to talk to the swarm, tell them to write on issue #69 (the assistant picks it up), or comment "/ask <role> ..." on an issue or PR to ask one role directly.
Labels: fm:todo, fm:in-progress, fm:rebuild (queued rebuild work), fm:rebuilding, fm:finding (spec gap for the planner), fm:intent (behaviour described in words, not built yet), fm:blocked (needs a human, via the assistant), fm:review, fm:changes, fm:needs-rebase, fm:approved, fm:human-ok, fm:ask-<role>.
Budget: $5/day, $150/month. Caps per run: plan and chief $0.40, assistant $0.60, review, merge and editor $1.00, prove and rebuild $3.00. The chief and the assistant only have to fit the month. Each run may take up to 200 model steps.
The four notebooks are issues: #38 the Ledger notebook (costs, digests, and the editor's fm-cycle markers), #55 the Swarm notebook (one task list per run), #53 the Chief notebook (the chief's audits), #69 the Assistant notebook (the assistant's thread with the maintainer); #71 the cycle 1 comparison.`;

export async function POST(request: Request) {
	if (!process.env.OPENAI_API_KEY) {
		return new Response("Chat is not configured. Set OPENAI_API_KEY in .env.local to enable responses.", { status: 503 });
	}
	const { messages, model: requested } = await request.json();
	const model: OpenAIModel = openAIModelNames.includes(requested) ? requested : "gpt-6-luna";

	let state: string;
	let repos = [SWARM_REPO];
	try {
		const session = await auth.getSession();
		const live = await getSwarmState(session?.user ? await listProjects(session.user.sub) : [LIVE_PROJECT]);
		repos = [SWARM_REPO, ...live.projects.flatMap((p) => (p.proofsRepo && p.proofsRepo !== SWARM_REPO ? [p.proofsRepo] : []))];
		state = JSON.stringify(live);
	} catch (error) {
		console.error("[swarm] state fetch failed:", error);
		state = "unavailable: the GitHub API request failed";
	}

	const result = streamText({
		model: model.startsWith("gpt-6") ? openai.responses(model) : openai(model),
		system: `You answer questions about what the formalmind swarm agents are doing. Be concise and concrete: name issue and PR numbers, labels, roles and dollar amounts. Answer only from the live state below; if it does not say, say so. One swarm (one team, one budget) works every project in "projects" that is inSwarm; each item names its proofs repository in "repo", and issue numbers are per repository, so always say which repository. "work" (open items and their current labels) and "merged" are the present truth. Comments in "chief", "notebook" and "ledger" are history with timestamps: when an older comment disagrees with the current labels or the merged list, trust the current state and mention that the comment is out of date. Today is ${new Date().toISOString().slice(0, 10)} (UTC). Link issues as https://github.com/<repo>/issues/<n>.
When the live state is not enough, use the tools to read an issue or PR thread, the files a PR changed, a run's steps, a file in the repository (.formal/plan.md holds the decisions and roadmap, or README.md in projects not yet moved; .formal/notebook.json the config; FORMAL_MIND.md the changelog), or to search issues. Prefer looking it up over guessing, and cite what you read.

${SWARM_RULES}

Live state (JSON, fetched just now):
${state}`,
		messages,
		tools: swarmTools(repos),
		maxSteps: 6,
	});

	return result.toDataStreamResponse({
		getErrorMessage: (error) => {
			console.error("[swarm] model request failed:", error);
			return error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "The model request failed.";
		},
	});
}
