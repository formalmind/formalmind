import type { Preview } from "@storybook/nextjs-vite";
import { withThemeByClassName } from "@storybook/addon-themes";
import "../app/globals.css";

const preview: Preview = {
	parameters: {
		layout: "padded",
		controls: { matchers: { color: /(background|color)$/i } },
	},
	decorators: [
		withThemeByClassName({ themes: { light: "", dark: "dark" }, defaultTheme: "light" }),
		(Story) => (
			<div className="bg-background text-sm text-foreground antialiased">
				<Story />
			</div>
		),
	],
};

export default preview;
