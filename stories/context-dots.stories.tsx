import type { Meta, StoryObj } from "@storybook/react-vite";
import { ContextDots } from "@/components/context-dots";

// Numbers from real `context` events: a prover on Codex early in its turn, and one near compaction.
const early = { system: 1300, task: 683, tools: 1767, used: 7524, window: 400000, compact_at: 300000, estimated: true };
const late = { system: 1300, task: 683, tools: 1767, used: 286000, window: 400000, compact_at: 300000 };

const meta = {
	title: "Swarm/Context dots",
	component: ContextDots,
	decorators: [(Story) => <div className="max-w-md p-4">{Story()}</div>],
} satisfies Meta<typeof ContextDots>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Early: Story = { args: { use: early } };
export const Running: Story = { args: { use: late, state: "running" } };
export const Loading: Story = { args: { state: "loading" } };
