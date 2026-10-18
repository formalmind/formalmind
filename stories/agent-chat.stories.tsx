import type { Meta, StoryObj } from "@storybook/react-vite";
import { AgentChat } from "@/components/swarm/agent-chat";
import type { AgentMessage } from "@/server/routes/swarm/agent/route";
import { json, withMockFetch } from "./mock-fetch";

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
const url = "https://github.com/asyncswap/v2-proofs/issues/69";

const conversation: AgentMessage[] = [
	{ id: 1, from: "you", author: "mmsaki", body: "What's left before the swap invariants are proven?", createdAt: at(42), url },
	{ id: 2, from: "agent", author: "formalmind[bot]", body: "Two pieces:\n\n- **#61** reserves and claim supply stay non-negative (queued, a prover picks it up next sweep)\n- **#64** fee accounting, blocked on a missing lemma about rounding\n\nWant me to re-plan #64 around the rounding lemma?", createdAt: at(30), url },
	{ id: 3, from: "you", author: "mmsaki", body: "Yes, re-plan it.", createdAt: at(5), url },
];

const projects = { projects: [{ repo: "asyncswap/v2", proofsRepo: "asyncswap/v2-proofs", addedAt: at(9000) }, { repo: "mmsaki/v4-core", proofsRepo: "mmsaki/v4-core-proofs", addedAt: at(60) }] };

/** Answers GET with the conversation so far and POST by appending what was sent. */
function agentRoute(messages: AgentMessage[]) {
	const thread = [...messages];
	return (init?: RequestInit) => {
		if (init?.method === "POST") {
			const { text } = JSON.parse(String(init.body)) as { text: string };
			thread.push({ id: thread.length + 1, from: "you", author: "mmsaki", body: text, createdAt: new Date().toISOString(), url });
			return json({ ok: true });
		}
		return json({ issue: 69, messages: thread });
	};
}

const meta = {
	title: "Swarm/Agent chat",
	component: AgentChat,
	args: { role: "assistant", repo: "asyncswap/v2-proofs" },
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div className="flex h-screen justify-end bg-muted/40 p-3">
				<aside className="flex w-[400px] flex-col overflow-hidden rounded-2xl border bg-background shadow-md">
					<Story />
				</aside>
			</div>
		),
	],
} satisfies Meta<typeof AgentChat>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A conversation with the assistant; the project chip picks which project a message is about. */
export const Assistant: Story = {
	decorators: [withMockFetch({ "/api/swarm/agent": agentRoute(conversation), "/api/projects": () => json(projects) })],
};

/** Nothing said yet. */
export const Empty: Story = {
	decorators: [withMockFetch({ "/api/swarm/agent": agentRoute([]), "/api/projects": () => json(projects) })],
};

/** Another agent: messages go out as /ask prover. */
export const Prover: Story = {
	args: { role: "prover" },
	decorators: [withMockFetch({ "/api/swarm/agent": agentRoute(conversation.slice(0, 2)), "/api/projects": () => json(projects) })],
};

/** The notebook can't be read. */
export const LoadError: Story = {
	decorators: [withMockFetch({ "/api/swarm/agent": () => new Response(JSON.stringify({ error: "GitHub is rate limiting us." }), { status: 502 }), "/api/projects": () => json(projects) })],
};
