import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { justFinishedState, liveState, replayState } from "./fixtures/swarm";

const meta = {
	title: "Swarm/Canvas",
	component: SwarmCanvas,
	parameters: { layout: "fullscreen" },
	decorators: [(Story) => <div className="p-6"><Story /></div>],
	argTypes: {
		highlight: { control: "select", options: [null, "dispatcher", "planner", "prover", "reviewer", "merger", "chief"] },
	},
} satisfies Meta<typeof SwarmCanvas>;

export default meta;
type Story = StoryObj<typeof meta>;

/** No run in the last 10 minutes: the cursors act out one trip through the labels, starting from the real queue. */
export const Replay: Story = { args: { state: replayState() } };

/** A prover is mid-run on #61; its cursor sits on the card with the task it is on. */
export const LiveProver: Story = { args: { state: liveState("prover") } };

export const LiveReviewer: Story = { args: { state: liveState("reviewer") } };

export const LiveMerger: Story = { args: { state: liveState("merger") } };

/** The planner works from the roadmap card. */
export const LivePlanner: Story = { args: { state: liveState("planner") } };

/** The chief's daily update finished two minutes ago and stays up until the live window closes. */
export const JustFinished: Story = { args: { state: justFinishedState() } };

/** One role's cursor stands out and the rest fade, as when a legend button is pressed. */
export const HighlightedRole: Story = { args: { state: replayState(), highlight: "prover" } };

/** Before the first poll answers. */
export const Loading: Story = { args: { state: null } };
