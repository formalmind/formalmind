import type { Meta, StoryObj } from "@storybook/react-vite";
import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { SidebarProvider } from "@/components/ui/sidebar";
import { liveState, replayState, severalProjectsState } from "./fixtures/swarm";
import { chatStream, json, withMockFetch } from "./mock-fetch";

const reply = () => chatStream([{ name: "searchIssues", args: { query: "label:fm:todo" }, result: { total: 1 } }], "One issue is queued: **#61**, reserves and claim supply stay non-negative. A prover picks it up on the next sweep.");

const meta = {
	title: "Swarm/Workspace",
	component: SwarmWorkspace,
	args: { repo: "asyncswap/v2-proofs" },
	parameters: { layout: "fullscreen" },
	decorators: [(Story) => <SidebarProvider><div className="flex h-screen w-full flex-col"><Story /></div></SidebarProvider>],
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

/** One swarm, three projects: the prover is on asyncswap/v3-proofs#4; asyncswap/hooks has no proofs repository yet. */
export const SeveralProjects: Story = {
	decorators: [withMockFetch({ "/api/swarm/state": () => json(severalProjectsState()), "/api/swarm/chat": reply })],
};

/** A project is added while the board is open: on the next poll (10 s) its lanes appear and the idle roles walk over. */
let polls = 0;
export const ProjectArrives: Story = {
	decorators: [
		withMockFetch({
			"/api/swarm/state": () => {
				const state = severalProjectsState();
				return json(polls++ === 0 ? { ...state, projects: state.projects.slice(0, 2) } : state);
			},
			"/api/swarm/chat": reply,
		}),
	],
};

/** GitHub is unreachable or rate limited. */
export const StateError: Story = {
	decorators: [withMockFetch({ "/api/swarm/state": () => new Response("rate limited", { status: 502 }), "/api/swarm/chat": reply })],
};
