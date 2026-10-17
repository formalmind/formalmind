import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { ProjectBoard } from "@/components/project/project-board";
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

/** One column per Status, like a GitHub project's Board layout. Hover a card for its GitHub preview. */
export const Board: StoryObj<typeof ProjectBoard> = {
	render: (args) => <ProjectBoard {...args} />,
	args: { repo: project.repo, items: project.items, milestones: project.milestones },
	decorators: [frame],
};

/** Work in every column. */
export const BoardBusy: StoryObj<typeof ProjectBoard> = {
	...Board,
	args: { ...Board.args, items: busyProject().items },
};

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

/** The whole page with tabs and the filter bar, fed by a mocked /api/project. Try "is:open" or "roadmap:5". */
export const Page: StoryObj<typeof ProjectView> = {
	render: (args) => <ProjectView {...args} />,
	args: { repo: project.repo, initialView: "board", now: snapshotNow },
	decorators: [withMockFetch({ "/api/project": () => json(busyProject()) }), page],
};

export const PageRoadmap: StoryObj<typeof ProjectView> = {
	...Page,
	args: { ...Page.args, initialView: "roadmap" },
};

export const PageError: StoryObj<typeof ProjectView> = {
	...Page,
	decorators: [withMockFetch({ "/api/project": () => new Response(JSON.stringify({ error: "Could not read the project from GitHub." }), { status: 502 }) }), page],
};
