import { redirect } from "next/navigation";

export default async function ProjectPage({ searchParams }: { searchParams: Promise<{ view?: string }> }) {
	redirect((await searchParams).view === "roadmap" ? "/roadmap" : "/kanban");
}
