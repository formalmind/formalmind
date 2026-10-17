import { redirect } from "next/navigation";

/** The Kanban view is gone; the swarm canvas is the board. Old links land on the roadmap. */
export default function KanbanPage() {
	redirect("/roadmap");
}
