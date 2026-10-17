import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ItemHoverCard } from "@/components/swarm/swarm-canvas";
import { mergedPr, openIssue } from "./fixtures/swarm";

const meta = {
	title: "Swarm/Item hover card",
	component: ItemHoverCard,
	args: { repo: "asyncswap/v2-proofs", left: 0, top: 0, below: true, onEnter: () => {}, onLeave: () => {} },
	decorators: [(Story) => <div className="relative h-56"><Story /></div>],
} satisfies Meta<typeof ItemHoverCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OpenIssue: Story = { args: { item: openIssue } };

export const MergedPullRequest: Story = { args: { item: mergedPr } };

export const InReview: Story = { args: { item: { ...mergedPr, merged: false, labels: ["fm:review"] } } };
