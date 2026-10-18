"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useChat } from "@ai-sdk/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Wrench } from "lucide-react";
import { ChatComposer } from "@/components/chat-composer";
import type { OpenAIModel } from "@/lib/models";
import type { UIMessage } from "ai";

const SUGGESTIONS = [
	"What is each agent doing right now?",
	"How much has the swarm spent today?",
	"Is anything waiting on me?",
	"What did the chief say last?",
];

/**
 * A chat with one project's swarm. `chatId` and `initialMessages` load a saved conversation, and
 * `onMessagesChange` hears each settled turn so the caller can keep it.
 */
export function SwarmChat({
	repo,
	chatId = "swarm-chat",
	initialMessages,
	onMessagesChange,
	ask,
	api = "/api/swarm/chat",
	body,
	intro,
	suggestions = SUGGESTIONS,
	placeholder = "Ask about the agents…",
	chip,
	footer,
}: {
	repo: string;
	/** Where the chat streams from; the private assistant uses /api/assistant. */
	api?: string;
	/** Sent with every turn, next to the model. */
	body?: Record<string, unknown>;
	/** Replaces the opening line shown before the first message. */
	intro?: ReactNode;
	suggestions?: string[];
	placeholder?: string;
	/** Replaces the "<repo> swarm" chip on the composer's shelf. */
	chip?: ReactNode;
	/** A line under the composer. */
	footer?: ReactNode;
	/** A question typed elsewhere (the canvas's composer); each new one is sent once. */
	ask?: { id: number; text: string } | null;
	chatId?: string;
	initialMessages?: UIMessage[];
	onMessagesChange?: (messages: UIMessage[]) => void;
}) {
	const [model, setModel] = useState<OpenAIModel>("gpt-6-luna");
	const { messages, input, setInput, handleInputChange, handleSubmit, append, stop, isLoading, error } = useChat({
		// A fixed id keeps the conversation when the sheet closes and opens again.
		id: chatId,
		api,
		body: { model, ...body },
		initialMessages,
	});
	const scrollRef = useRef<HTMLDivElement>(null);
	const asked = useRef<number | null>(null);
	useEffect(() => {
		if (!ask || asked.current === ask.id) return;
		asked.current = ask.id;
		void append({ role: "user", content: ask.text });
	}, [ask, append]);
	const onChange = useRef(onMessagesChange);
	onChange.current = onMessagesChange;

	// Save once a turn has settled, not on every streamed token.
	useEffect(() => {
		if (!isLoading && messages.length > 0) onChange.current?.(messages);
	}, [isLoading, messages]);

	useEffect(() => {
		scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
	}, [messages]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div ref={scrollRef} className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4">
				{messages.length === 0 ? (
					<div className="space-y-3">
						{intro ?? (
							<p className="text-sm text-muted-foreground">
								Ask what the agents are doing. Answers come from the live issues, labels and comments in{" "}
								<a href={`https://github.com/${repo}`} className="text-foreground underline underline-offset-4">{repo}</a>.
							</p>
						)}
						<div className="flex flex-col items-start gap-2">
							{suggestions.map((s) => (
								<button
									key={s}
									type="button"
									onClick={() => append({ role: "user", content: s })}
									className="rounded-full border bg-background px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-secondary"
								>
									{s}
								</button>
							))}
						</div>
					</div>
				) : null}
				{messages.map((m) => (
					<div key={m.id} className={m.role === "user" ? "flex justify-end" : ""}>
						{m.role === "user" ? (
							<p className="max-w-[85%] rounded-2xl bg-secondary px-3.5 py-2 text-sm text-secondary-foreground">{m.content}</p>
						) : (
							<div>
								<ToolCalls message={m} />
								<div className="prose prose-sm max-w-none leading-6 dark:prose-invert prose-p:my-2 prose-ul:my-2 prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none">
								<ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
								</div>
							</div>
						)}
					</div>
				))}
				{isLoading && messages.at(-1)?.role === "user" ? <p className="text-sm text-muted-foreground">Reading the swarm…</p> : null}
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
					placeholder={placeholder}
					context={
						chip ?? (
							<span className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-sm font-medium text-secondary-foreground">
								{repo} swarm
							</span>
						)
					}
				/>
				{footer}
			</div>
		</div>
	);
}

const TOOL_LABELS: Record<string, (args: Record<string, unknown>) => string> = {
	getIssue: (a) => `Read #${a.number}`,
	getPullRequestFiles: (a) => `Files in PR #${a.number}`,
	getRun: (a) => `Run ${a.runId}`,
	readFile: (a) => `Read ${a.path}`,
	listFiles: (a) => `Listed ${a.path || "/"}`,
	searchIssues: (a) => `Searched “${a.query}”`,
	askAgent: (a) => `Asked the ${a.role}${a.number ? ` on #${a.number}` : ""}`,
	commentOn: (a) => `Commented on #${a.number}`,
	openIssue: (a) => `Opened “${a.title}”`,
	setLabels: (a) => `Labels on #${a.number}`,
};

/** The lookups the model made for this answer, so it is clear where the answer came from. */
export function ToolCalls({ message }: { message: UIMessage }) {
	const calls = (message.parts ?? []).flatMap((part) => (part.type === "tool-invocation" ? [part.toolInvocation] : []));
	if (!calls.length) return null;
	return (
		<div className="mb-2 flex flex-wrap gap-1.5">
			{calls.map((call) => (
				<span key={call.toolCallId} className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-sm text-muted-foreground">
					<Wrench className={`size-3 ${call.state === "result" ? "" : "animate-pulse"}`} />
					{(TOOL_LABELS[call.toolName] ?? (() => call.toolName))(call.args as Record<string, unknown>)}
				</span>
			))}
		</div>
	);
}
