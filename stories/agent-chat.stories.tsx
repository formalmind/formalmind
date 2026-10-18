import type { Meta, StoryObj } from "@storybook/react-vite";
import type { UIMessage } from "ai";
import { AgentChat } from "@/components/swarm/agent-chat";
import { chatStream, json, withMockFetch } from "./mock-fetch";

const conversation: UIMessage[] = [
	{ id: "1", role: "user", content: "What's left before the swap invariants are proven?", parts: [{ type: "text", text: "What's left before the swap invariants are proven?" }] },
	{
		id: "2",
		role: "assistant",
		content: "Two pieces:\n\n- **#61** reserves and claim supply stay non-negative (queued, a prover picks it up next sweep)\n- **#64** fee accounting, blocked on a missing lemma about rounding\n\nWant me to ask the planner to re-plan #64 around the rounding lemma?",
		parts: [{ type: "text", text: "Two pieces: …" }],
	},
];

const reply = () =>
	chatStream(
		[{ name: "askAgent", args: { role: "planner", request: "Re-plan #64 around a rounding lemma.", number: 64 }, result: { url: "https://github.com/asyncswap/v2-proofs/issues/64#issuecomment-1" } }],
		"Done: I asked the **planner** on [#64](https://github.com/asyncswap/v2-proofs/issues/64) to re-plan it around the rounding lemma. It takes the next turn.",
	);

/** GET returns the saved conversation; PUT saves; POST streams the assistant's answer. */
const assistantRoute = (messages: UIMessage[]) => (init?: RequestInit) =>
	init?.method === "POST" ? reply() : json(init?.method === "PUT" ? { ok: true } : { messages });

const projects = () => json({ projects: [{ repo: "asyncswap/v2", proofsRepo: "asyncswap/v2-proofs" }, { repo: "mmsaki/v4-core", proofsRepo: "mmsaki/v4-core-proofs" }] });

const meta = {
	title: "Swarm/Agent chat",
	component: AgentChat,
	args: { role: "assistant", repo: "asyncswap/v2-proofs" },
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div className="flex h-screen justify-end bg-muted/40 p-3">
				<aside className="flex w-[400px] flex-col overflow-hidden rounded-2xl border bg-background">
					<Story />
				</aside>
			</div>
		),
	],
} satisfies Meta<typeof AgentChat>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A private conversation with the assistant, picked up where it was left. */
export const Assistant: Story = { decorators: [withMockFetch({ "/api/assistant": assistantRoute(conversation), "/api/projects": projects })] };

/** Nothing said yet: suggestions to start from. */
export const Empty: Story = { decorators: [withMockFetch({ "/api/assistant": assistantRoute([]), "/api/projects": projects })] };

/** Opened from the prover on the canvas; the assistant relays to it. */
export const Prover: Story = { args: { role: "prover" }, decorators: [withMockFetch({ "/api/assistant": assistantRoute([]), "/api/projects": projects })] };
