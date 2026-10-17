import { Suspense, lazy, useEffect, useMemo } from "react";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { Loader2 } from "lucide-react";
import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { SwarmChat } from "@/components/swarm/swarm-chat";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
	getProjectChat,
	newChatId,
	projectPath,
	repoOf,
	saveProjectChat,
	useProjects,
	type Project,
} from "@/components/projects/use-projects";

const ProjectView = lazy(() => import("@/components/project/project-view").then((m) => ({ default: m.ProjectView })));

/** The project named by the route, or a redirect / loading state while that is settled. */
function useRouteProject(): { project: Project | null; repo: string | null; loading: boolean } {
	const { owner, name } = useParams<{ owner: string; name: string }>();
	const repo = repoOf(owner, name);
	const projects = useProjects();
	return { repo, loading: projects === null, project: projects?.find((p) => p.repo === repo) ?? null };
}

function Loading() {
	return (
		<div className="flex flex-1 items-center gap-2 p-6 text-sm text-muted-foreground">
			<Loader2 className="size-4 animate-spin" /> Loading the project…
		</div>
	);
}

/** Shown for a project whose swarm has not started: it gets a proofs repository at the end of setup. */
function NotStarted({ repo, what }: { repo: string; what: string }) {
	return (
		<div className="flex flex-1 flex-col p-4 sm:p-6">
			<div className="flex items-center gap-3">
				<SidebarTrigger className="-ml-1" />
				<h1 className="text-sm">{repo}</h1>
			</div>
			<div className="mt-10 max-w-md">
				<p className="text-sm text-foreground">The swarm for {repo} hasn&apos;t started yet.</p>
				<p className="mt-1 text-sm leading-6 text-muted-foreground">
					Its {what} shows up here once setup is finished and the agents have a proofs repository to work in.
				</p>
				<Link to={`/onboarding?repo=${encodeURIComponent(repo)}`} className="mt-4 inline-flex h-9 items-center rounded-full bg-primary px-4 text-sm text-primary-foreground hover:opacity-90">
					Finish setup
				</Link>
			</div>
		</div>
	);
}

function Unknown() {
	return <Navigate to="/" replace />;
}

export function ProjectSwarmPage() {
	const { project, repo, loading } = useRouteProject();
	if (loading) return <Loading />;
	if (!project || !repo) return <Unknown />;
	if (!project.proofsRepo) return <NotStarted repo={repo} what="board" />;
	return <SwarmWorkspace repo={project.proofsRepo} />;
}

export function ProjectRoadmapPage() {
	const { project, repo, loading } = useRouteProject();
	if (loading) return <Loading />;
	if (!project || !repo) return <Unknown />;
	if (!project.proofsRepo) return <NotStarted repo={repo} what="roadmap" />;
	return (
		<Suspense fallback={<Loading />}>
			<ProjectView repo={project.proofsRepo} />
		</Suspense>
	);
}

/** `/projects/:owner/:name/chat` starts a new chat; `/chat/:chatId` opens a saved one. */
export function ProjectChatPage() {
	const { project, repo, loading } = useRouteProject();
	const { chatId } = useParams<{ chatId?: string }>();
	const navigate = useNavigate();

	useEffect(() => {
		if (repo && project?.proofsRepo && !chatId) navigate(projectPath(repo, `chat/${newChatId()}`), { replace: true });
	}, [repo, project, chatId, navigate]);

	const saved = useMemo(() => (repo && chatId ? getProjectChat(repo, chatId) : undefined), [repo, chatId]);

	if (loading) return <Loading />;
	if (!project || !repo) return <Unknown />;
	if (!project.proofsRepo) return <NotStarted repo={repo} what="chat" />;
	if (!chatId) return <Loading />;
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-3 p-4 pb-0 sm:px-6 sm:pt-6">
				<SidebarTrigger className="-ml-1" />
				<h1 className="min-w-0 truncate text-sm">{saved?.title ?? "New chat"}</h1>
				<span className="shrink-0 text-sm text-muted-foreground">{repo}</span>
			</div>
			<div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
				{/* Keyed by chat so switching chats starts from that chat's own messages. */}
				<SwarmChat
					key={chatId}
					repo={project.proofsRepo}
					chatId={`${repo}:${chatId}`}
					initialMessages={saved?.messages}
					onMessagesChange={(messages) => saveProjectChat(repo, chatId, messages)}
				/>
			</div>
		</div>
	);
}

/** `/` and the old `/roadmap`: the first project. */
export function FirstProject({ page = "" }: { page?: string }) {
	const projects = useProjects();
	if (projects === null) return <Loading />;
	const first = projects[0];
	return first ? <Navigate to={projectPath(first.repo, page)} replace /> : <Navigate to="/onboarding?new=1" replace />;
}
