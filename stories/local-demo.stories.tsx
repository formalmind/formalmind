import type { Meta, StoryObj } from "@storybook/react-vite";
import { LocalDemoPage } from "@/components/local-demo";

/** The desktop app's local-folder page with the sample folder (demo data): the Swarm page and its floating chat. */
const meta = {
	title: "Desktop/Local folder",
	component: LocalDemoPage,
	parameters: { layout: "fullscreen" },
	decorators: [
		(Story) => (
			<div className="h-screen w-full">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof LocalDemoPage>;

export default meta;
type Story = StoryObj<typeof meta>;

/** Drag the chat's left edge, top edge or top-left corner to resize it; scrolled up, new messages don't pull you down. */
export const Swarm: Story = {};
