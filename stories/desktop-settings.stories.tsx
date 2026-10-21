import type { Meta, StoryObj } from "@storybook/react-vite";
import { SettingsPage } from "../desktop/src/settings";

/** What the Mac app's Tauri commands answer here: two local folders and one imported repository. */
const answers: Record<string, unknown> = {
	config_get: { folders: ["/Users/you/contracts", "/Users/you/v2-raff"], repos: { "asyncswap/v2": "/Users/you/.formal/repos/v2" } },
	anthropic_key_status: true,
};

/** The Mac app's Settings page: a menu of subsections on the left, the picked one (kept in `?section=`) on the right. */
const meta = {
	title: "Desktop/Settings",
	component: SettingsPage,
	parameters: { layout: "fullscreen", route: "/settings" },
	beforeEach: () => {
		const w = window as unknown as Record<string, unknown>;
		w.__TAURI_INTERNALS__ = { invoke: async (cmd: string) => answers[cmd] ?? null, transformCallback: () => 0 };
		return () => void delete w.__TAURI_INTERNALS__;
	},
} satisfies Meta<typeof SettingsPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Models: Story = {};

/** A link to `/settings?section=audit-folders` opens straight on that section. */
export const AuditFolders: Story = { parameters: { route: "/settings?section=audit-folders" } };
