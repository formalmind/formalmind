import type { Meta, StoryObj } from "@storybook/react-vite";
import { HomeEmpty } from "../components/home-empty";

/** The home page's empty screen: the headline (with the parts' icons) and the next step. */
const meta = {
	title: "Home/Empty",
	component: HomeEmpty,
	args: { muted: "Bugs, proofs and code.", strong: "Pick a project to start.", hint: "Choose one in the sidebar, or add one." },
} satisfies Meta<typeof HomeEmpty>;
export default meta;

export const Default: StoryObj<typeof meta> = {};
