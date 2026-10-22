import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { ArrowDown, ArrowUp, Brain, Check, ChevronDown, Copy, RotateCcw, Share, Sparkles, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { ToolCalls } from "@/components/swarm/swarm-chat";
import { notify } from "@/lib/notifications";
import { CenterState } from "./bar";

/*
 * Chat with Formal Mind on formal.team (/api/chat, about one project), drawn as the askmike app draws its chat: yours in
 * a bubble on the right, the replies as plain text with a row of actions under them, a loader until the first words,
 * a jump-to-bottom button when you scroll up, and a composer that grows to five lines. Conversations are kept on the
 * phone, per project.
 */

export type CloudChatMeta = { id: string; title: string; updated: number };

const listKey = (repo: string) => `fm:cloud-chats:${repo}`;
const chatKey = (id: string) => `fm:cloud-chat:${id}`;

function readJson<T>(key: string, fallback: T): T {
	try {
		const v = localStorage.getItem(key);
		return v ? (JSON.parse(v) as T) : fallback;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		/* kept for this visit */
	}
	window.dispatchEvent(new Event("fm:cloud-chats"));
}

/** This project's conversations with Formal Mind, newest first. */
export function cloudChats(repo: string): CloudChatMeta[] {
	return readJson<CloudChatMeta[]>(listKey(repo), []).sort((a, b) => b.updated - a.updated);
}

/** The conversations, kept current as they're saved. */
export function useCloudChats(repo: string) {
	const [list, setList] = useState(() => cloudChats(repo));
	useEffect(() => {
		const on = () => setList(cloudChats(repo));
		on();
		window.addEventListener("fm:cloud-chats", on);
		return () => window.removeEventListener("fm:cloud-chats", on);
	}, [repo]);
	return list;
}

export const newCloudChatId = () => `c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function save(repo: string, id: string, messages: UIMessage[]) {
	if (!messages.length) return;
	const first = messages.find((m) => m.role === "user")?.content ?? "New chat";
	writeJson(chatKey(id), messages);
	const rest = readJson<CloudChatMeta[]>(listKey(repo), []).filter((c) => c.id !== id);
	writeJson(listKey(repo), [{ id, title: first.replace(/\s+/g, " ").slice(0, 80), updated: Date.now() }, ...rest].slice(0, 50));
}

/** Mike's loader: four dots that breathe in turn, until the first words arrive. */
function Thinking() {
	return (
		<span aria-label="Thinking" className="flex h-[22px] items-center gap-[5px]">
			{[0, 1, 2, 3].map((i) => (
				<span key={i} className="fm-think-dot size-[5px] rounded-full bg-foreground" style={{ animationDelay: `${i * 140}ms` }} />
			))}
		</span>
	);
}

/** The reply's reasoning, folded: "Thinking…" while it streams, "Thought process" after. */
function Reasoning({ text, live }: { text: string; live: boolean }) {
	const [open, setOpen] = useState(false);
	return (
		<div className="mb-2">
			<button type="button" onClick={() => setOpen(!open)} className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-muted-foreground">
				<Brain className="size-3.5" />
				<span className={live ? "fm-shimmer-text" : ""}>{live ? "Thinking…" : "Thought process"}</span>
				<ChevronDown className={`size-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
			</button>
			{open ? <p className="mt-1.5 whitespace-pre-wrap rounded-[10px] bg-muted px-2.5 py-2 text-[12px] leading-5 text-muted-foreground">{text}</p> : null}
		</div>
	);
}

/** Under a finished reply: copy, share, and a thumbs up or down (kept with the message). */
function Actions({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const [vote, setVote] = useState<"up" | "down" | null>(null);
	const icon = "size-[15px]";
	return (
		<div className="mt-2 flex items-center gap-[18px] text-muted-foreground">
			<button
				type="button"
				aria-label="Copy"
				onClick={() => {
					void navigator.clipboard.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					});
				}}
			>
				{copied ? <Check className={`${icon} text-emerald-600 dark:text-emerald-400`} /> : <Copy className={icon} />}
			</button>
			{typeof navigator.share === "function" ? (
				<button type="button" aria-label="Share" onClick={() => void navigator.share({ text }).catch(() => {})}>
					<Share className={icon} />
				</button>
			) : null}
			<button type="button" aria-label="Good reply" onClick={() => setVote(vote === "up" ? null : "up")}>
				<ThumbsUp className={`${icon} ${vote === "up" ? "fill-current text-foreground" : ""}`} />
			</button>
			<button type="button" aria-label="Bad reply" onClick={() => setVote(vote === "down" ? null : "down")}>
				<ThumbsDown className={`${icon} ${vote === "down" ? "fill-current text-foreground" : ""}`} />
			</button>
		</div>
	);
}

const SUGGESTIONS = ["What does this project do?", "Where should an audit of it start?", "How do Lean proofs check Solidity?", "What makes a finding Critical?"];

/**
 * One conversation with Formal Mind about `repo`. `chatId` names it (a new id starts an empty one); `shelf` is the chip
 * on the composer (which chat this is, and the way to your Mac's sessions).
 */
export function CloudChat({ repo, chatId, shelf, aboveTabs }: { repo: string; chatId: string; shelf?: React.ReactNode; aboveTabs?: boolean }) {
	const [initial] = useState(() => readJson<UIMessage[]>(chatKey(chatId), []));
	const { messages, input, setInput, append, reload, stop, status, error } = useChat({
		id: chatId,
		api: "/api/chat",
		body: { project: repo },
		initialMessages: initial,
		experimental_throttle: 50,
	});
	const busy = status === "submitted" || status === "streaming";
	useEffect(() => {
		if (error) notify.error("Formal Mind didn't reply", { description: error.message });
	}, [error]);

	// Kept once a turn settles, not on every streamed word.
	useEffect(() => {
		if (!busy) save(repo, chatId, messages);
	}, [busy, messages, repo, chatId]);

	// Following the reply: only while you're at the bottom (within 80px), as in Mike's.
	const scroller = useRef<HTMLDivElement>(null);
	const [atBottom, setAtBottom] = useState(true);
	const follow = useRef(true);
	useLayoutEffect(() => {
		if (follow.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [messages]);
	const toBottom = () => {
		follow.current = true;
		scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
	};

	// The box grows with what you write, up to five lines.
	const box = useRef<HTMLTextAreaElement>(null);
	useLayoutEffect(() => {
		const el = box.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 5 * 24 + 4)}px`;
	}, [input]);

	const ask = (text: string) => {
		const t = text.trim();
		if (!t || busy) return;
		follow.current = true;
		setInput("");
		void append({ role: "user", content: t });
	};

	const last = messages.at(-1);
	const waiting = busy && (last?.role === "user" || (last?.role === "assistant" && !last.content && !(last.parts ?? []).some((p) => p.type === "reasoning")));

	return (
		<div className="fm-chat flex min-h-0 flex-1 flex-col">
			<div
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
					follow.current = bottom;
					setAtBottom(bottom);
				}}
				onTouchStart={() => (document.activeElement as HTMLElement | null)?.blur()}
				className="fm-under-floating min-h-0 flex-1 space-y-[14px] overflow-y-auto px-4 pb-3 text-[16px] leading-relaxed"
			>
				{messages.length === 0 ? (
					<div className="flex min-h-[60dvh] flex-col">
						<CenterState icon={<Sparkles className="size-7" strokeWidth={1.6} />} muted="Formal Mind." strong={`Ask about ${repo.split("/")[1]}.`} body="Answers come from Formal Mind on formal.team, about this project.">
							{/* Mike's pills: a wrapping row, sent as soon as they're tapped. */}
							<div className="flex flex-wrap justify-center gap-2">
								{SUGGESTIONS.map((s) => (
									<button key={s} type="button" onClick={() => ask(s)} className="rounded-full border bg-muted/60 px-3.5 py-2 text-[15px] active:bg-muted">
										{s}
									</button>
								))}
							</div>
						</CenterState>
					</div>
				) : null}
				{messages.map((m, i) => {
					const reasoning = (m.parts ?? []).flatMap((p) => (p.type === "reasoning" ? [p.reasoning] : [])).join("\n\n");
					const live = busy && i === messages.length - 1;
					return m.role === "user" ? (
						<div key={m.id} className="flex justify-end pl-10">
							<div className="fm-bubble w-fit select-text whitespace-pre-wrap rounded-2xl p-3 text-foreground">{m.content}</div>
						</div>
					) : (
						<div key={m.id} className="fm-reply select-text py-0.5">
							{reasoning ? <Reasoning text={reasoning} live={live && !m.content} /> : null}
							<ToolCalls message={m} />
							{m.content ? <ChatMarkdown>{m.content}</ChatMarkdown> : null}
							{!live && m.content ? <Actions text={m.content} /> : null}
						</div>
					);
				})}
				{waiting ? <Thinking /> : null}
				{/* What went wrong is in the bell; here, only the way to try again. */}
				{error ? (
					<button type="button" onClick={() => void reload()} className="flex items-center gap-1.5 text-[14px] font-medium text-muted-foreground">
						<RotateCcw className="size-3.5" /> The reply didn&apos;t come. Try again
					</button>
				) : null}
			</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					if (busy && !input.trim()) stop();
					else ask(input);
				}}
				className={`fm-composer-dock relative shrink-0 px-3 ${aboveTabs ? "fm-above-tabs" : "fm-safe-bottom"}`}
			>
				{/* Back to the end, centred over the composer, when you've scrolled up. */}
				<button
					type="button"
					onClick={toBottom}
					aria-label="Scroll to the end"
					className={`fm-glass absolute -top-[42px] left-1/2 grid size-9 -translate-x-1/2 place-items-center rounded-full transition-all duration-200 ${atBottom || !messages.length ? "pointer-events-none scale-75 opacity-0" : "scale-100 opacity-100"}`}
				>
					<ArrowDown className="size-[15px]" strokeWidth={2.6} />
				</button>
				<div className="fm-glass rounded-[28px] p-3">
					<textarea
						ref={box}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						rows={1}
						placeholder={`Ask about ${repo.split("/")[1]}…`}
						className="block min-h-[28px] w-full resize-none bg-transparent px-1 py-0.5 leading-6 outline-none placeholder:text-muted-foreground"
					/>
					<div className="mt-2.5 flex items-center gap-2">
						<span className="inline-flex h-8 min-w-0 items-center rounded-full bg-foreground/[0.06] px-3 text-[13px] font-medium">{shelf ?? "Formal Mind"}</span>
						<button
							type="submit"
							disabled={!busy && !input.trim()}
							aria-label={busy && !input.trim() ? "Stop" : "Send"}
							className="ml-auto grid size-8 shrink-0 place-items-center rounded-full bg-foreground text-background disabled:bg-foreground/[0.08] disabled:text-muted-foreground"
						>
							{busy && !input.trim() ? <Square className="size-3 fill-current" /> : <ArrowUp className="size-4" strokeWidth={2.6} />}
						</button>
					</div>
				</div>
			</form>
		</div>
	);
}
