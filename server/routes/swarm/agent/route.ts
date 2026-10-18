import { Octokit } from "@octokit/rest";
import { auth, isDevPreview } from "@/lib/auth";
import { ASSISTANT_ISSUE, SWARM_REPO, github, type SwarmRole } from "@/lib/swarm";

/**
 * Talking to one agent. Everything goes through the assistant's notebook, issue #69, the way the swarm's rules say:
 * whatever the maintainer writes there wakes the assistant, and "/ask <role> ..." gives that role the next turn.
 * Messages are posted as the signed-in user (their GitHub token from Auth0's token vault), so the swarm sees the
 * maintainer, not the bot.
 */

const ROLES: SwarmRole[] = ["dispatcher", "planner", "prover", "rebuilder", "reviewer", "merger", "editor", "chief", "assistant"];

type GitHubComment = { id: number; body: string; created_at: string; html_url: string; user: { login: string; type: string } | null };

export interface AgentMessage {
	id: number;
	from: "you" | "agent";
	author: string;
	body: string;
	createdAt: string;
	url: string;
}

function roleOf(request: Request): SwarmRole | null {
	const role = new URL(request.url).searchParams.get("role") as SwarmRole | null;
	return role && ROLES.includes(role) ? role : null;
}

/** The names the swarm's workflows sign with ("**review** answering …"), where they differ from the role. */
const SIGNED_AS: Partial<Record<SwarmRole, string[]>> = {
	planner: ["plan"],
	prover: ["prove"],
	reviewer: ["review"],
	merger: ["merge"],
	rebuilder: ["rebuild"],
	editor: ["edit"],
	dispatcher: ["dispatch"],
};

/** A bot comment belongs to a role when it opens with that role's bold name, the swarm's convention. */
function isFromRole(body: string, role: SwarmRole) {
	const names = [role, ...(SIGNED_AS[role] ?? [])].join("|");
	return new RegExp(`^\\s*(<!--[^>]*-->\\s*)*\\*\\*(${names})\\*\\*`, "i").test(body);
}

/** The latest of this agent's replies on #69, and what people sent it there. */
export async function GET(request: Request) {
	const role = roleOf(request);
	if (!role) return Response.json({ error: "Which agent?" }, { status: 400 });
	try {
		const meta = await github<{ comments: number }>(`/issues/${ASSISTANT_ISSUE}`);
		const page = Math.max(1, Math.ceil(meta.comments / 100));
		const comments = await github<GitHubComment[]>(`/issues/${ASSISTANT_ISSUE}/comments?per_page=100&page=${page}`);
		const messages: AgentMessage[] = comments.flatMap((c) => {
			const bot = c.user?.type === "Bot";
			const asks = new RegExp(`^\\s*/ask\\s+${role}\\b`, "i").test(c.body);
			const relevant = bot ? isFromRole(c.body, role) : role === "assistant" ? !/^\s*\/ask\s+/i.test(c.body) || asks : asks;
			if (!relevant) return [];
			return [{
				id: c.id,
				from: bot ? "agent" : "you",
				author: c.user?.login ?? "ghost",
				// Hide the /ask prefix and the swarm's hidden markers; they are plumbing, not conversation.
				body: c.body.replace(new RegExp(`^\\s*/ask\\s+${role}\\s*`, "i"), "").replace(/<!--[\s\S]*?-->/g, "").trim(),
				createdAt: c.created_at,
				url: c.html_url,
			}];
		});
		return Response.json({ role, issue: ASSISTANT_ISSUE, repo: SWARM_REPO, messages: messages.slice(-40) });
	} catch (error) {
		console.error("[agent] thread read failed:", error);
		return Response.json({ error: "Couldn't read the conversation from GitHub just now." }, { status: 502 });
	}
}

/** Sends a message to the agent as a comment on #69, written by the signed-in user. */
export async function POST(request: Request) {
	const role = roleOf(request);
	const { text } = (await request.json().catch(() => ({}))) as { text?: string };
	const message = text?.trim();
	if (!role || !message) return Response.json({ error: "Write something to send." }, { status: 400 });
	if (isDevPreview) return Response.json({ error: "Sending needs a real sign-in (dev preview)." }, { status: 503 });
	const body = role === "assistant" ? message : `/ask ${role} ${message}`;
	try {
		const token = await auth.getGitHubToken();
		const octokit = new Octokit({ auth: token, userAgent: "formalmind" });
		const [owner, repo] = SWARM_REPO.split("/");
		const { data } = await octokit.rest.issues.createComment({ owner, repo, issue_number: ASSISTANT_ISSUE, body });
		return Response.json({ ok: true, url: data.html_url });
	} catch (error) {
		console.error("[agent] send failed:", error);
		const status = (error as { status?: number }).status;
		const reason = status === 403 || status === 404
			? `GitHub didn't let your account comment on ${SWARM_REPO}#${ASSISTANT_ISSUE} (${(error as Error).message}). Sign out and sign in again so Formal Mind can post as you.`
			: `Couldn't send it to GitHub just now (${(error as Error).message}). Try again in a moment.`;
		return Response.json({ error: reason }, { status: 502 });
	}
}
