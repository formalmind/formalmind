import type { ThinkLevel } from "@/lib/models";
import { useEffect, useMemo, useRef, useState } from "react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { Navigate, useNavigate, useParams } from "react-router";
import { Loader2 } from "lucide-react";
import { ChatComposer } from "@/components/chat-composer";
import { ProjectPicker } from "@/components/projects/project-picker";
import { useChatWithInterruptions } from "@/hooks/useChatWithInterruptions";
import type { OpenAIModel } from "@/lib/llm";
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

function Unknown() {
	return <Navigate to="/" replace />;
}

/** A project's page opens its code: Code, Proofs and Bugs read the repository at a commit. */
export function ProjectHomePage() {
	const { project, repo, loading } = useRouteProject();
	if (loading) return <Loading />;
	if (!project || !repo) return <Unknown />;
	return <Navigate to={projectPath(repo, "code")} replace />;
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
