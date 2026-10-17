import { ProjectView } from "@/components/project/project-view";
import { SWARM_REPO } from "@/lib/swarm";

export const metadata = { title: "Kanban · Formal Mind" };

export default function KanbanPage() {
	return <ProjectView repo={SWARM_REPO} initialView="board" />;
}
