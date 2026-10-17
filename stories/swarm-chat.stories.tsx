import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import type { UIMessage } from "ai";
import { SwarmChat, ToolCalls } from "@/components/swarm/swarm-chat";
import { chatStream, withMockFetch } from "./mock-fetch";

const ANSWER = `**PR #63** added \`AsyncSwapProtocol/V2/BalNonNeg.lean\` (3 files, +214 lines) with \`step_bal_nonneg\`: no v2 step can drive a balance negative.

Before merging, the merger checked:
- \`step_bal_nonneg\` at \`BalNonNeg.lean:155\` with no \`sorry\`
- the \`swapGuard\` gap against \`Model.lean:341-343\`
- \`Router.sol:351\` as the second \`safeTransferFrom\` for the bid

It merged as \`8153ac3\` and left a follow-up for the planner to tighten \`swapGuard\`.`;

const LOOKUPS = [
	{ name: "getPullRequestFiles", args: { number: 63 }, result: [{ file: "AsyncSwapProtocol/V2/BalNonNeg.lean", status: "added", additions: 198, deletions: 0 }] },
	{ name: "getIssue", args: { number: 63, comments: 10 }, result: { number: 63, state: "merged" } },
	{ name: "readFile", args: { path: "AsyncSwapProtocol/V2/BalNonNeg.lean", ref: "dev" }, result: { size: 7400 } },
	{ name: "readFile", args: { path: "FORMAL_MIND.md", ref: "dev" }, result: { size: 5200 } },
];

const meta = {
	title: "Swarm/Chat",
	component: SwarmChat,
	args: { repo: "asyncswap/v2-proofs" },
	decorators: [
		withMockFetch({ "/api/swarm/chat": () => chatStream(LOOKUPS, ANSWER) }),
		(Story) => <div className="flex h-[640px] w-[380px] flex-col rounded-xl border"><Story /></div>,
	],
} satisfies Meta<typeof SwarmChat>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Answers come from a canned stream: four lookups, then the reply. Pick a suggestion or ask anything. */
export const Default: Story = {};

const call = (toolCallId: string, toolName: string, args: Record<string, unknown>, done = true) => ({
	type: "tool-invocation" as const,
	toolInvocation: done ? { state: "result" as const, toolCallId, toolName, args, result: {} } : { state: "call" as const, toolCallId, toolName, args },
});

/** The chips above an answer, one per lookup; a pulsing wrench means the lookup is still running. */
export const ToolChips: StoryObj<typeof ToolCalls> = {
	render: (args) => <ToolCalls {...args} />,
	args: {
		message: {
			id: "m1",
			role: "assistant",
			content: "",
			parts: [
				call("1", "getPullRequestFiles", { number: 63 }),
				call("2", "getIssue", { number: 63, comments: 10 }),
				call("3", "getRun", { runId: 38989427643 }),
				call("4", "readFile", { path: "FORMAL_MIND.md", ref: "dev" }),
				call("5", "listFiles", { path: "AsyncSwapProtocol/V2", ref: "dev" }),
				call("6", "searchIssues", { query: "label:fm:blocked" }, false),
			],
		} as UIMessage,
	},
};
