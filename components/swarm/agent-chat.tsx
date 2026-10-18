import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, Loader2 } from "lucide-react";
import { ChatComposer } from "@/components/chat-composer";
import type { SwarmRole } from "@/lib/swarm";
import { ROLE_COLORS } from "@/lib/swarm-roles";
import type { AgentMessage } from "@/server/routes/swarm/agent/route";

const POLL_MS = 8_000;

/** What each agent is for, said to the person about to write to it. */
const INTRO: Partial<Record<SwarmRole, string>> = {
	assistant: "Your assistant. Tell it what you want done, ask what's going on, or answer its questions; it acts on your behalf and asks you only when a decision is yours.",
	planner: "Plans the work. Ask it to scope something new or re-plan what's blocked.",
	prover: "Writes the Lean. Ask about a proof or what it's stuck on.",
	reviewer: "Reviews each PR. Ask why it bounced something or what it wants changed.",
	merger: "Verifies and merges. Ask what's holding a PR.",
	chief: "Audits the day. Ask for a status summary.",
};

/**
 * A chat with one agent, carried on the assistant's notebook issue: what you send is posted there as you (with
 * "/ask <role>" for agents other than the assistant), and its replies show up as they're written.
 */
export function AgentChat({ role, repo }: { role: SwarmRole; repo: string }) {
	const [messages, setMessages] = useState<AgentMessage[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [sending, setSending] = useState(false);
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
		const message = text.trim();
		if (!message || sending) return;
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
				{INTRO[role] ? <p className="text-sm text-muted-foreground">{INTRO[role]}</p> : null}
				{messages === null && !error ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : null}
				{messages?.length === 0 ? <p className="text-sm text-muted-foreground">No messages yet. Say hello.</p> : null}
				{messages?.map((m) => (
					<div key={m.id} className={`flex ${m.from === "you" ? "justify-end" : "justify-start"}`}>
						<div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${m.from === "you" ? "bg-foreground text-background" : "border bg-background"}`}>
							<div className="chat-markdown prose prose-sm max-w-none break-words dark:prose-invert [&_p]:my-1">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>{m.body}</ReactMarkdown>
							</div>
							<a href={m.url} target="_blank" rel="noreferrer" className={`mt-1 inline-flex items-center gap-1 text-[11px] ${m.from === "you" ? "text-background/60" : "text-muted-foreground"} hover:underline`}>
								{new Date(m.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
								<ExternalLink className="size-3" />
							</a>
						</div>
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
					context={
						<span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-sm font-medium capitalize text-secondary-foreground">
							<span className="size-2 rounded-full" style={{ backgroundColor: ROLE_COLORS[role] }} />
							{role}
						</span>
					}
				/>
				<p className="mt-1.5 px-3 text-[11px] text-muted-foreground">
					Posted as you on{" "}
					<a href={`https://github.com/${repo}/issues/${issue}`} target="_blank" rel="noreferrer" className="underline underline-offset-2">
						{repo}#{issue}
					</a>
					{role === "assistant" ? "" : `, as /ask ${role}`}. Replies arrive on the swarm's next turn.
				</p>
			</div>
		</div>
	);
}
