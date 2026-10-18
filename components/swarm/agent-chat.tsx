import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy, ExternalLink, Globe, Loader2 } from "lucide-react";
import { ChatComposer } from "@/components/chat-composer";
import { ProjectPicker } from "@/components/projects/project-picker";
/** The swarm's home project, whose notebook these chats are carried on (LIVE_PROJECT in lib/projects). */
const HOME_PROJECT = "asyncswap/v2";
import type { SwarmRole } from "@/lib/swarm";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import type { AgentMessage } from "@/server/routes/swarm/agent/route";

const POLL_MS = 8_000;

/**
 * A chat with one agent, carried on the assistant's notebook issue: what you send is posted there as you (with
 * "/ask <role>" for agents other than the assistant), and its replies show up as they're written.
 */
export function AgentChat({ role, repo }: { role: SwarmRole; repo: string }) {
	const [messages, setMessages] = useState<AgentMessage[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
	// Which project the message is about; the notebook is shared, so other projects are named in the message.
	const [project, setProject] = useState(HOME_PROJECT);
	const [issue, setIssue] = useState(69);
	const listRef = useRef<HTMLDivElement>(null);

	const load = useCallback(async () => {
		try {
			const res = await fetch(`/api/swarm/agent?role=${role}`);
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? res.statusText);
			setMessages(body.messages);
			setIssue(body.issue);
			setError(null);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't load the conversation.");
		}
	}, [role]);

	useEffect(() => {
		setMessages(null);
		void load();
		const timer = setInterval(() => document.visibilityState === "visible" && void load(), POLL_MS);
		return () => clearInterval(timer);
	}, [load]);

	useEffect(() => {
		listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
	}, [messages]);

	const send = async () => {
		const typed = text.trim();
		const message = project === HOME_PROJECT ? typed : `On ${project}: ${typed}`;
		if (!typed || sending) return;
		setSending(true);
		try {
			const res = await fetch(`/api/swarm/agent?role=${role}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: message }) });
			const body = await res.json();
			if (!res.ok) throw new Error(body.error ?? res.statusText);
			setText("");
			setError(null);
			await load();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Couldn't send it.");
		} finally {
			setSending(false);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={listRef} className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4">
				{messages === null && !error ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
				{messages?.length === 0 ? <p className="text-sm text-muted-foreground">No messages yet. Say hello.</p> : null}
				{messages?.map((m) => (
					<div key={m.id} className={`group flex flex-col ${m.from === "you" ? "items-end" : "items-start"}`}>
						<div className={m.from === "you" ? "max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm text-secondary-foreground" : "max-w-full text-sm"}>
							<div className="chat-markdown prose prose-sm max-w-none break-words leading-6 dark:prose-invert [&_p]:my-1">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
							</div>
						</div>
						<MessageActions text={m.body} url={m.url} />
					</div>
				))}
				{error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p> : null}
			</div>
			<div className="shrink-0 px-3 pb-3">
				<ChatComposer
					value={text}
					onChange={(e) => setText(e.target.value)}
					onSubmit={() => void send()}
					onStop={() => {}}
					isLoading={sending}
					placeholder={`Message the ${role}…`}
					context={<ProjectPicker repo={project} onSelect={setProject} />}
				/>
				<p className="mt-2 flex items-start gap-1.5 px-3 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
					<Globe className="mt-px size-3 shrink-0" />
					<span>
						Not private: everything here is posted publicly as you on{" "}
						<a href={`https://github.com/${repo}/issues/${issue}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
							{repo}#{issue}
						</a>
						{role === "assistant" ? "" : ` (as /ask ${role})`}. Replies arrive on the swarm&apos;s next turn.
					</span>
				</p>
			</div>
		</div>
	);
}

/** Copy the message, or open it on GitHub. */
function MessageActions({ text, url }: { text: string; url: string }) {
	const [copied, setCopied] = useState(false);
	const button = "flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";
	return (
		<div className="mt-1 flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
			<button
				type="button"
				aria-label="Copy"
				title="Copy"
				className={button}
				onClick={() => {
					void navigator.clipboard.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
			</button>
			<a href={url} target="_blank" rel="noreferrer" aria-label="Open on GitHub" title="Open on GitHub" className={button}>
				<ExternalLink className="size-3.5" />
			</a>
		</div>
	);
}
