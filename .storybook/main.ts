import type { StorybookConfig } from "@storybook/nextjs-vite";

const config: StorybookConfig = {
	stories: ["../stories/**/*.stories.@(ts|tsx)"],
	addons: ["@storybook/addon-docs", "@storybook/addon-themes"],
	framework: { name: "@storybook/nextjs-vite", options: {} },
	staticDirs: ["../public"],
};

export default config;
