import { redirect } from "next/navigation";
import { ProjectView } from "@/components/project/project-view";
import { SWARM_REPO } from "@/lib/swarm";

export const metadata = { title: "Board · Formal Mind" };

export default async function BoardPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
	if ((await searchParams).view === "roadmap") redirect("/roadmap");
	return <ProjectView repo={SWARM_REPO} initialView="board" />;
}
