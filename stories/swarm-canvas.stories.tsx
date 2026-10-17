import type { Meta, StoryObj } from "@storybook/react-vite";
import { SwarmCanvas } from "@/components/swarm/swarm-canvas";
import { askState, handoffState, justFinishedState, liveState, replayState } from "./fixtures/swarm";

const meta = {
	title: "Swarm/Canvas",
	component: SwarmCanvas,
	parameters: { layout: "fullscreen" },
	decorators: [(Story) => <div className="p-6"><Story /></div>],
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

/** A finished turn hands the baton: the reviewer names the merger, who steps up to the PR. */
export const Handoff: Story = { args: { state: handoffState() } };

/** The prover asked the reviewer a question; the reviewer waits at #61 for its turn to answer. */
export const QuestionWaiting: Story = { args: { state: askState() } };

/** The chief's daily update finished two minutes ago and stays up until the live window closes. */
export const JustFinished: Story = { args: { state: justFinishedState() } };

/** Before the first poll answers. */
export const Loading: Story = { args: { state: null } };
