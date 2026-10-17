import type { StorybookConfig } from "@storybook/react-vite";

const config: StorybookConfig = {
	stories: ["../stories/**/*.stories.@(ts|tsx)"],
	addons: ["@storybook/addon-docs", "@storybook/addon-themes"],
	framework: { name: "@storybook/react-vite", options: {} },
	staticDirs: ["../public"],
};

export default config;
