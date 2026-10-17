import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { GetStarted } from "@/components/get-started";

const meta = {
	title: "Pages/Get started",
	component: GetStarted,
	parameters: { layout: "fullscreen" },
	decorators: [(Story) => <div className="px-6 py-8"><Story /></div>],
} satisfies Meta<typeof GetStarted>;

export default meta;
export const Default: StoryObj<typeof meta> = {};
