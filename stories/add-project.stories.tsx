import type { Meta, StoryObj } from "@storybook/react-vite";
import { AddProjectCard } from "../components/add-project";

/** Adding a project: a local folder (the Mac app's picker) or a GitHub repository. */
const meta = {
	title: "Home/Add a project",
	component: AddProjectCard,
	decorators: [(Story) => <div className="max-w-md p-6"><Story /></div>],
	args: { onCancel: () => {} },
} satisfies Meta<typeof AddProjectCard>;
export default meta;

export const Default: StoryObj<typeof meta> = {};
