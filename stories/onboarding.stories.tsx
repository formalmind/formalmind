import type { Meta, StoryObj } from "@storybook/react-vite";
import { Landing } from "@/components/landing/landing";
import { PlanBoard } from "@/components/landing/plan-board";
import type { RepoPlan } from "@/lib/plan";
import plan from "./fixtures/plan-v4-core.json";
import { withMockFetch } from "./mock-fetch";

const v4 = plan as RepoPlan;

/** The plan arrives as JSON text in chunks, the way streamObject sends it. */
function planStream(delayMs = 60) {
	const text = JSON.stringify(v4);
	const encoder = new TextEncoder();
	return new Response(new ReadableStream<Uint8Array>({
		async start(controller) {
			for (let i = 0; i < text.length; i += 40) {
				controller.enqueue(encoder.encode(text.slice(i, i + 40)));
				await new Promise((r) => setTimeout(r, delayMs));
			}
			controller.close();
		},
	}), { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

const meta = {
	title: "Onboarding",
	parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;

/** The public landing page. Pick an example repository to watch a (canned) plan stream in. */
export const LandingPage: StoryObj<typeof Landing> = {
	render: (args) => <Landing {...args} />,
	args: { signedIn: false },
	decorators: [withMockFetch({ "/api/onboarding/plan": () => planStream() })],
};

/** The planner's finished first pass on Uniswap v4-core (a real plan). */
export const PlanDone: StoryObj<typeof PlanBoard> = {
	render: (args) => <div className="p-6"><PlanBoard {...args} /></div>,
	args: { repo: "Uniswap/v4-core", plan: v4, status: "done" },
};

/** Midway: contracts read, two invariants in, no issues yet. */
export const PlanStreaming: StoryObj<typeof PlanBoard> = {
	...PlanDone,
	args: { repo: "Uniswap/v4-core", plan: { summary: v4.summary, contracts: v4.contracts, invariants: v4.invariants.slice(0, 2) }, status: "planning" },
};
