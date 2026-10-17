import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ProjectRoadmap } from "@/components/project/project-roadmap";
import { ProjectView } from "@/components/project/project-view";
import { SidebarProvider } from "@/components/ui/sidebar";
import { busyProject, project, snapshotNow } from "./fixtures/project";
import { json, withMockFetch } from "./mock-fetch";

const meta = {
	title: "Project",
	parameters: { layout: "fullscreen" },
} satisfies Meta;

export default meta;

const frame = (Story: React.ComponentType) => <div className="h-[720px] p-6"><Story /></div>;

/** Items on a timeline from opened to merged, grouped by the README's roadmap items. */
export const Roadmap: StoryObj<typeof ProjectRoadmap> = {
	render: (args) => <ProjectRoadmap {...args} />,
	args: { repo: project.repo, items: project.items, milestones: project.milestones, now: snapshotNow },
	decorators: [frame],
};

/** Open work runs to today with a dashed end. */
export const RoadmapBusy: StoryObj<typeof ProjectRoadmap> = {
	...Roadmap,
	args: { ...Roadmap.args, items: busyProject().items },
};

const page = (Story: React.ComponentType) => <SidebarProvider><div className="flex h-screen w-full flex-col"><Story /></div></SidebarProvider>;

/** The whole page with the filter bar, fed by a mocked /api/project. Try "is:open" or "roadmap:5". */
export const Page: StoryObj<typeof ProjectView> = {
	render: (args) => <ProjectView {...args} />,
	args: { repo: project.repo, now: snapshotNow },
	decorators: [withMockFetch({ "/api/project": () => json(busyProject()) }), page],
};

export const PageError: StoryObj<typeof ProjectView> = {
	...Page,
	decorators: [withMockFetch({ "/api/project": () => new Response(JSON.stringify({ error: "Could not read the project from GitHub." }), { status: 502 }) }), page],
};
