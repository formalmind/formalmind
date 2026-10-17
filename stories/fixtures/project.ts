import type { ProjectData, ProjectItem, ProjectStatus } from "@/lib/project";
import snapshot from "./project.json";

/** A real snapshot of asyncswap/v2-proofs as a project (stories/fixtures/project.json). */
export const project = snapshot as ProjectData;
/** The moment the snapshot was taken, so "today" on the roadmap stays put. */
export const snapshotNow = Date.parse(project.fetchedAt);

const LABEL: Partial<Record<ProjectStatus, string>> = {
	"in-progress": "fm:in-progress",
	approved: "fm:approved",
	blocked: "fm:blocked",
	todo: "fm:todo",
};

/** The same project mid-sprint: some of the latest work reopened into every column. */
export function busyProject(): ProjectData {
	const plan: [number, ProjectStatus][] = [[63, "approved"], [60, "in-progress"], [59, "review"], [57, "blocked"], [52, "todo"], [51, "review"]];
	const items = project.items.map((item): ProjectItem => {
		const status = plan.find(([n]) => n === item.number)?.[1];
		if (!status) return item;
		const label = LABEL[status];
		return { ...item, status, state: "open", merged: false, closedAt: null, labels: label ? [label] : [] };
	});
	return { ...project, items };
}
