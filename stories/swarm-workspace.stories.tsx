import type { Meta, StoryObj } from "@storybook/react-vite";
import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { SidebarProvider } from "@/components/ui/sidebar";
import { liveState, replayState } from "./fixtures/swarm";
import { chatStream, json, withMockFetch } from "./mock-fetch";

const reply = () => chatStream([{ name: "searchIssues", args: { query: "label:fm:todo" }, result: { total: 1 } }], "One issue is queued: **#61**, reserves and claim supply stay non-negative. A prover picks it up on the next sweep.");

const meta = {
	title: "Swarm/Workspace",
	component: SwarmWorkspace,
	args: { repo: "asyncswap/v2-proofs" },
	parameters: { layout: "fullscreen" },
	decorators: [(Story) => <SidebarProvider><div className="h-screen w-full"><Story /></div></SidebarProvider>],
} satisfies Meta<typeof SwarmWorkspace>;

export default meta;
type Story = StoryObj<typeof meta>;

/** The home page: board, recent runs, legend and the chat, fed by a mocked /api/swarm/state. */
export const Replay: Story = {
	decorators: [withMockFetch({ "/api/swarm/state": () => json(replayState()), "/api/swarm/chat": reply })],
};

export const LiveRun: Story = {
	decorators: [withMockFetch({ "/api/swarm/state": () => json(liveState("prover")), "/api/swarm/chat": reply })],
};

/** GitHub is unreachable or rate limited. */
export const StateError: Story = {
	decorators: [withMockFetch({ "/api/swarm/state": () => new Response("rate limited", { status: 502 }), "/api/swarm/chat": reply })],
};
