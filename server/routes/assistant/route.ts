import { streamText, type Message } from "ai";
import { auth } from "@/lib/auth";
import { getJSON, putJSON } from "@/lib/kv";
import { openAIModelNames, type OpenAIModel } from "@/lib/llm";
import { openai } from "@/lib/openai";
import { LIVE_PROJECT, listProjects } from "@/lib/projects";
import { getSwarmState, SWARM_REPO, type SwarmRole } from "@/lib/swarm";
import { assistantTools } from "@/lib/tools/assistant-tools";
import { swarmTools } from "@/lib/tools/swarm-tools";
import { SWARM_RULES } from "@/server/routes/swarm/chat/route";

/**
 * The private assistant: a chat between the signed-in person and their assistant, kept in KV under their account
 * and never posted to GitHub. The assistant reads the swarm and acts on GitHub as formalmind[bot] when asked.
 * `role` opens the chat about one agent; the assistant relays to it.
 */

const ROLES: SwarmRole[] = ["assistant", "planner", "prover", "rebuilder", "reviewer", "merger", "editor", "chief", "dispatcher"];
const roleOf = (value: unknown): SwarmRole => (ROLES.includes(value as SwarmRole) ? (value as SwarmRole) : "assistant");
const key = (sub: string, role: SwarmRole) => `assistant-chat:${sub}:${role}`;

/** This person's private conversation (with the assistant, or about one agent). */
export async function GET(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const role = roleOf(new URL(request.url).searchParams.get("role"));
	return Response.json({ role, messages: (await getJSON<Message[]>(key(session.user.sub, role))) ?? [] });
}

/** Saves the conversation once a turn has settled (the browser sends it). */
export async function PUT(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	const { role, messages } = (await request.json()) as { role?: string; messages?: Message[] };
	if (!Array.isArray(messages)) return Response.json({ error: "No messages." }, { status: 400 });
	await putJSON(key(session.user.sub, roleOf(role)), messages.slice(-200));
	return Response.json({ ok: true });
}

export async function POST(request: Request) {
	const session = await auth.getSession();
	if (!session?.user) return Response.json({ error: "Sign in first." }, { status: 401 });
	if (!process.env.OPENAI_API_KEY) return new Response("Chat is not configured: OPENAI_API_KEY is missing.", { status: 503 });
	const { messages, model: requested, role: asked, project: picked } = await request.json();
	const role = roleOf(asked);
	const model: OpenAIModel = openAIModelNames.includes(requested) ? requested : "gpt-6-luna";
	const who = (session.user.nickname as string | undefined) ?? "the maintainer";

	let state: string;
	let repos = [SWARM_REPO];
	const projects = await listProjects(session.user.sub).catch(() => [LIVE_PROJECT]);
	const project = projects.find((p) => p.repo === picked) ?? LIVE_PROJECT;
	try {
		const live = await getSwarmState(projects);
		repos = [SWARM_REPO, ...live.projects.flatMap((p) => (p.proofsRepo && p.proofsRepo !== SWARM_REPO ? [p.proofsRepo] : []))];
		state = JSON.stringify(live);
	} catch (error) {
		console.error("[assistant] state fetch failed:", error);
		state = "unavailable: the GitHub API request failed";
	}

	const where = project.proofsRepo
		? `\nThe user picked the project ${project.repo}; its proofs repository is ${project.proofsRepo}. Talk about that project unless they name another, and act there (pass repo "${project.proofsRepo}"); never post about it in another project's repository.`
		: `\nThe user picked the project ${project.repo}, which has no proofs repository yet; tell them to finish its Setup before the swarm can work on it.`;
	const focus =
		role === "assistant"
			? ""
			: `\nThe user opened this chat from the ${role} on the canvas: they want to talk to the ${role}. Answer from what the ${role} has done (its comments, PRs and notebook notes). When they want the ${role} to answer or do something, relay it with askAgent (role "${role}") and say its reply will appear on GitHub on its next turn; you can read it with the tools when they come back.`;

	const result = streamText({
		model: model.startsWith("gpt-6") ? openai.responses(model) : openai(model),
		system: `You are @${who}'s private assistant for their formalmind swarm. This conversation is private: it is stored only in their Formal Mind account and is never posted to GitHub. Be concise and concrete: name repositories, issue and PR numbers, labels, roles and dollar amounts. Today is ${new Date().toISOString().slice(0, 10)} (UTC).
Read with the lookup tools; act with askAgent, commentOn, openIssue and setLabels, which post as formalmind[bot]. Act when the user asks for something clearly; when a request is ambiguous or would spend budget on new work, say what you'd do and ask first. Never post the user's words verbatim to GitHub unless they ask; write what the swarm needs to know. After acting, link what you posted.${focus}${where}

${SWARM_RULES}

Live state (JSON, fetched just now):
${state}`,
		messages,
		tools: { ...swarmTools(repos), ...assistantTools(repos, who, project.proofsRepo ?? SWARM_REPO) },
		maxSteps: 8,
	});

	return result.toDataStreamResponse({
		getErrorMessage: (error) => {
			console.error("[assistant] model request failed:", error);
			return error instanceof Error ? error.message.replace(/sk-[A-Za-z0-9_-]+/g, "[redacted]") : "The model request failed.";
		},
	});
}
