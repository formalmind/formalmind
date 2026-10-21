import type { Preview } from "@storybook/react-vite";
import { withThemeByClassName } from "@storybook/addon-themes";
import { MemoryRouter } from "react-router";
import "../src/globals.css";

const preview: Preview = {
	parameters: {
		layout: "padded",
		controls: { matchers: { color: /(background|color)$/i } },
	},
	decorators: [
		withThemeByClassName({ themes: { light: "", dark: "dark" }, defaultTheme: "light" }),
		// A story can start at a URL with `parameters: { route: "/settings?section=editor" }`.
		(Story, { parameters }) => (
			<MemoryRouter initialEntries={[(parameters.route as string | undefined) ?? "/"]}>
				<div className="bg-background text-sm text-foreground antialiased">
					<Story />
				</div>
			</MemoryRouter>
		),
	],
};

export default preview;
