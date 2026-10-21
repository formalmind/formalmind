import type { ThinkLevel } from "@/lib/models";
import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import type { UIMessage } from "ai";
import { Loader2 } from "lucide-react";
import { SwarmChat } from "@/components/swarm/swarm-chat";
import { SwarmWorkspace } from "@/components/swarm/swarm-workspace";
import { NavGroup } from "@/desktop/src/swarm-panel";
import { ChatComposer } from "@/components/chat-composer";
import { ProjectPicker } from "@/components/projects/project-picker";
import { useChatWithInterruptions } from "@/hooks/useChatWithInterruptions";
import type { OpenAIModel } from "@/lib/llm";
import { SWARM_REPO } from "@/lib/swarm-repo";
import {
	getProjectChat,
	newChatId,
	projectPath,
	repoOf,
	saveProjectChat,
	setChatWorking,
	useProjects,
	type Project,
} from "@/components/projects/use-projects";

/** The swarm's own conversation is kept beside the project chats, under this key. */
const SWARM_CHAT_KEY = "swarm";

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
/**
 * A project whose specs aren't being built yet. Formal Mind builds a repository's specs from its commits, in a proofs
 * repository beside it (set up once); proving is done in the app, on the Proofs tab here or in the Mac app.
 */
function NotStarted({ repo, what }: { repo: string; what: string }) {
	const name = repo.split("/")[1] ?? repo;
	return (
		// Below the tabs, centred, in the app's card.
		<div className="flex flex-1 items-center justify-center p-6 pt-20">
			<section className="w-full max-w-md rounded-2xl border bg-muted/60 p-1.5">
				<h1 className="flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{what === "roadmap" ? "Roadmap" : "Swarm"} · {name}</h1>
				<div className="shadow-card space-y-3 rounded-xl border bg-card p-4 text-[13px]">
					<p className="font-medium">Specs for {name} aren&apos;t being built yet.</p>
					<p className="leading-6 text-muted-foreground">
						Formal Mind writes the specs as commits land, in a proofs repository kept beside {name}; its {what} shows here once that is set up. Proving them is done in the app: on the Proofs tab, or in the Mac app.
					</p>
					<div className="flex flex-wrap gap-2 pt-1">
						<Link to={`/onboarding?repo=${encodeURIComponent(repo)}`} className="btn-dark h-9 px-4">
							Set up specs
						</Link>
						<Link to={`${projectPath(repo, "code")}?mode=audit`} className="btn-soft h-9 px-4">
							Open Proofs
						</Link>
					</div>
				</div>
			</section>
		</div>
	);
}

function Unknown() {
	return <Navigate to="/" replace />;
}

/** A project's own page is its roadmap; the swarm is one board across every project, on the home page. */
/** A project's home: the swarm's map, narrowed to this project's agents and work. */
export function ProjectHomePage() {
	const { project, repo, loading } = useRouteProject();
	const navigate = useNavigate();
	useEffect(() => {
		if (repo) document.title = `${repo.split("/")[1]} · Formal Mind`;
	}, [repo]);
	if (loading) return <Loading />;
	if (!project || !repo) return <Unknown />;
	return (
		// The same tabs as the folder page: Code, Proofs and Bugs open the repository's page; Swarm is this canvas.
		<div className="relative flex min-h-0 flex-1 flex-col">
			{project.proofsRepo ? <SwarmWorkspace repo={project.proofsRepo} only={repo} /> : <NotStarted repo={repo} what="swarm" />}
			<NavGroup name={repo.split("/")[1] ?? repo} git mode="swarm" onMode={(m) => m !== "swarm" && navigate(`${projectPath(repo, "code")}?mode=${m}`)} />
		</div>
	);
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

/** A normal chat about one project. Its messages are kept in this browser and listed in the project's folder. */
function ProjectChat({ repo, chatId }: { repo: string; chatId: string }) {
	const saved = useMemo(() => getProjectChat(repo, chatId), [repo, chatId]);
	const [model, setModel] = useState<OpenAIModel>("gpt-6-luna");
	const [think, setThink] = useState<ThinkLevel>("medium");
	const { messages, input, setInput, handleInputChange, handleSubmit, stop, isLoading, error } = useChatWithInterruptions({
		model,
		think,
		id: `${repo}:${chatId}`,
		initialMessages: saved?.messages ?? [],
		project: repo,
	});
	const scrollRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages]);
	useEffect(() => {
		if (!isLoading && messages.length > 0) saveProjectChat(repo, chatId, messages);
	}, [isLoading, messages, repo, chatId]);
	// While the agent answers, the chat shows a dot in the sidebar; a new chat is listed as soon as it starts working.
	const latest = useRef(messages);
	latest.current = messages;
	useEffect(() => {
		setChatWorking(repo, chatId, isLoading);
		if (isLoading && latest.current.length > 0) saveProjectChat(repo, chatId, latest.current);
	}, [isLoading, repo, chatId]);
	useEffect(() => () => setChatWorking(repo, chatId, false), [repo, chatId]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-3 p-4 pb-0 sm:px-6 sm:pt-6">
				<h1 className="min-w-0 truncate text-sm">{saved?.title ?? "New chat"}</h1>
			</div>
			<div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
				<div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
					{messages.length === 0 ? <p className="text-sm text-muted-foreground">Ask anything about {repo}.</p> : null}
					{messages.map((m) => (
						<div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
							{m.role === "user" ? (
								<p className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm text-secondary-foreground">{m.content}</p>
							) : (
								<ChatMarkdown>{m.content}</ChatMarkdown>
							)}
						</div>
					))}
					{error ? <p className="text-sm text-destructive">{error.message}</p> : null}
				</div>
				<div className="p-3 pt-0">
					<ChatComposer
						value={input}
						onChange={handleInputChange}
						onSubmit={() => {
							handleSubmit();
							setInput("");
						}}
						onStop={stop}
						isLoading={isLoading}
						model={model}
						onModelChange={setModel}
							think={think}
							onThinkChange={setThink}
						placeholder={`Ask about ${repo}…`}
						context={<ProjectPicker repo={repo} />}
					/>
				</div>
			</div>
		</div>
	);
}

/** `/projects/:owner/:name/chat` starts a new chat; `/chat/:chatId` opens a saved one. */
export function ProjectChatPage() {
	const { project, repo, loading } = useRouteProject();
	const { chatId } = useParams<{ chatId?: string }>();
	const navigate = useNavigate();

	useEffect(() => {
		if (repo && project && !chatId) navigate(projectPath(repo, `chat/${newChatId()}`), { replace: true });
	}, [repo, project, chatId, navigate]);

	if (loading) return <Loading />;
	if (!project || !repo) return <Unknown />;
	if (!chatId) return <Loading />;
	// Keyed by chat so switching chats starts from that chat's own messages.
	return <ProjectChat key={`${repo}:${chatId}`} repo={repo} chatId={chatId} />;
}

/** "Ask the swarm": one conversation with the swarm, as a page of its own. */
export function SwarmChatPage() {
	const saved = useMemo(() => getProjectChat(SWARM_CHAT_KEY, "main"), []);
	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-3 p-4 pb-0 sm:px-6 sm:pt-6">
				<h1 className="text-sm">Ask the swarm</h1>
				<Link to="/swarm" className="text-sm text-muted-foreground hover:text-foreground">Back to the swarm</Link>
			</div>
			<div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col">
				<SwarmChat
					repo={SWARM_REPO}
					chatId="swarm-chat"
					initialMessages={saved?.messages as UIMessage[] | undefined}
					onMessagesChange={(messages) => saveProjectChat(SWARM_CHAT_KEY, "main", messages)}
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
	return first ? <Navigate to={projectPath(first.repo, page)} replace /> : <Navigate to="/?add=1" replace />;
}
