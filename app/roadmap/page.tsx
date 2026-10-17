import { ProjectView } from "@/components/project/project-view";
import { SWARM_REPO } from "@/lib/swarm";

export const metadata = { title: "Roadmap · Formal Mind" };

export default function RoadmapPage() {
	return <ProjectView repo={SWARM_REPO} />;
}
