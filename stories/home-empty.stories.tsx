import type { Meta, StoryObj } from "@storybook/react-vite";
import { HomeEmpty } from "../components/home-empty";
import { WebHome } from "../components/web-home";

/** The home page's empty screen: the headline (cycling the parts with their icons) and the next step. */
const meta = {
	title: "Home/Empty",
	component: HomeEmpty,
	args: { muted: "Bugs, proofs and code.", strong: "Pick a project to start.", hint: "Choose one in the sidebar, or add one." },
} satisfies Meta<typeof HomeEmpty>;
export default meta;

export const Default: StoryObj<typeof meta> = {};

/** The website's home: "add one" puts the Add a project card in the headline's place (Cancel brings it back). */
export const WithAddOne: StoryObj<typeof meta> = { render: () => <WebHome /> };
