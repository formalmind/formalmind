import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { ArrowUp, ChevronRight, Folder, Loader2, Play, Square } from "lucide-react";
import { NotificationCenter } from "@/components/notification-center";
import { Message, MessageContent } from "@/components/ui/message";
import { AgentMessage, blocks, Steps, type Ev } from "@/desktop/src/swarm-panel";
import { TopBar } from "./bar";
import { hasHistory, macOnline, send, useMac, useSession } from "./relay";

const sessionHref = (folder: string, run: string) => `/mac/session?${new URLSearchParams({ folder, run })}`;

export function Offline() {
	const m = useMac();
	if (!m.loaded || macOnline(m)) return null;
	return (
		<p className="mx-4 mt-3 rounded-xl border bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground">
			{m.state ? "Your Mac is offline. Messages wait up to 10 minutes for it; open Formal Mind there to carry on." : "Sign in to Formal Mind on your Mac (Settings → Phone) to follow its swarm here."}
		</p>
	);
}

/** Your Mac: its folders and their swarm sessions, the running ones first. */
export function MacScreen() {
	const m = useMac();
	const online = macOnline(m);
	return (
		<div className="min-h-dvh bg-background">
			<TopBar back="/" title="Swarm on your Mac" sub={!m.loaded ? "Connecting…" : online ? "Online" : "Offline"} right={<NotificationCenter />} />
			<Offline />
			<main className="fm-safe-bottom space-y-5 px-4 py-4">
				{m.state?.folders.length === 0 ? <p className="text-sm text-muted-foreground">No folders on your Mac yet. Add one in Formal Mind there.</p> : null}
				{m.state?.folders.map((f) => (
					<section key={f.path}>
						<h2 className="mb-2 flex items-center gap-1.5 px-1 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
							<Folder className="size-3.5" /> {f.name}
						</h2>
						<ul className="divide-y overflow-hidden rounded-2xl border bg-card shadow-card">
							{[...f.sessions].sort((a, b) => Number(b.running) - Number(a.running)).map((s) => (
								<li key={s.run}>
									<Link to={sessionHref(f.path, s.run)} className="flex items-center gap-3 px-4 py-3 active:bg-muted">
										<span className={`size-2 shrink-0 rounded-full ${s.running ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/30"}`} />
										<span className="min-w-0 flex-1">
											<span className="block truncate font-medium">{s.title || (s.run === "swarm" ? "Swarm" : s.run)}</span>
											<span className="block truncate text-[12px] text-muted-foreground">
												{s.running ? "Running" : s.outcome || "Stopped"} · ${s.spent.toFixed(2)}
											</span>
										</span>
										<ChevronRight className="size-4 text-muted-foreground" />
									</Link>
								</li>
							))}
							{f.sessions.length === 0 ? (
								<li>
									<Link to={sessionHref(f.path, "swarm")} className="flex items-center gap-3 px-4 py-3 text-[14px] text-muted-foreground active:bg-muted">
										<Play className="size-4" /> No sessions yet: start one
									</Link>
								</li>
							) : null}
						</ul>
					</section>
				))}
			</main>
		</div>
	);
}

/** One swarm session on its own screen (from the Mac's list). */
export function SessionScreen() {
	const [params] = useSearchParams();
	const folder = params.get("folder") ?? "";
	const run = params.get("run") ?? "swarm";
	const m = useMac();
	const folderState = m.state?.folders.find((f) => f.path === folder);
	const session = folderState?.sessions.find((s) => s.run === run);
	return (
		<div className="flex h-dvh flex-col bg-background">
			<TopBar back="/mac" title={session?.title || (run === "swarm" ? "Swarm" : run)} sub={folderState?.name ?? folder.split("/").pop()} right={<NotificationCenter />} />
			<Offline />
			<SessionChat folder={folder} run={run} />
		</div>
	);
}

/**
 * One swarm session: what its agents say, and a composer that talks to it; Start and Stop run on the Mac. `aboveTabs`
 * keeps the composer clear of the floating tab bar (the project's Chat tab).
 */
export function SessionChat({ folder, run, aboveTabs, header }: { folder: string; run: string; aboveTabs?: boolean; header?: React.ReactNode }) {
	const m = useMac();
	const events = useSession(folder, run) as Ev[];
	const folderState = m.state?.folders.find((f) => f.path === folder);
	const session = folderState?.sessions.find((s) => s.run === run);
	const running = !!session?.running;
	const online = macOnline(m);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState<"send" | "start" | "stop" | null>(null);
	const [error, setError] = useState<string | null>(null);

	// The relay keeps recent events; the whole session comes from the Mac's log, once per visit.
	const asked = useRef("");
	useEffect(() => {
		const key = `${folder}\n${run}`;
		if (asked.current === key || !online || hasHistory(folder, run)) return;
		asked.current = key;
		void send({ type: "history", folder, run }).catch(() => {});
	}, [folder, run, online]);

	const chat = useMemo(() => blocks(events.filter((e) => !["status", "context", "start", "history"].includes(e.kind))), [events]);
	const working = running ? [...events].reverse().find((e) => e.kind === "status" && e.role !== "swarm") : undefined;
	const spent = events.at(-1)?.spent ?? session?.spent ?? 0;

	const scroller = useRef<HTMLDivElement>(null);
	const atBottom = useRef(true);
	useEffect(() => {
		if (atBottom.current) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
	}, [chat.length]);

	const act = async (kind: "send" | "start" | "stop") => {
		setError(null);
		setBusy(kind);
		try {
			if (kind === "send") {
				const t = text.trim();
				if (!t) return;
				await send({ type: "say", folder, run, text: t });
				setText("");
				atBottom.current = true;
			} else if (kind === "start") {
				await send({ type: "start", folder, run, goal: text.trim() || undefined });
				setText("");
			} else await send({ type: "stop", folder, run });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	return (
		<>
			<div className="flex shrink-0 items-center gap-2 border-b px-4 py-2">
				<span className={`size-2 shrink-0 rounded-full ${running ? "animate-pulse bg-emerald-500" : "bg-muted-foreground/30"}`} />
				<span className="min-w-0 flex-1 truncate text-[13px] text-muted-foreground">
					{header ?? (running ? "Running" : "Stopped")}
				</span>
				<span className="shrink-0 font-mono text-[12px] text-muted-foreground">
					${spent.toFixed(2)}
				</span>
				{running ? (
					<button type="button" disabled={!!busy} onClick={() => void act("stop")} className="inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium text-red-600 active:bg-red-500/10 disabled:opacity-50 dark:text-red-400">
						<Square className="size-3.5 fill-current" /> Stop
					</button>
				) : (
					<button type="button" disabled={!!busy || !online} onClick={() => void act("start")} className="btn-dark inline-flex h-8 items-center gap-1.5 px-3 text-[13px] disabled:opacity-50">
						{busy === "start" ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5 fill-current" />} Start
					</button>
				)}
			</div>
			<div
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4 text-[15px]"
			>
				{chat.length === 0 ? <p className="text-sm text-muted-foreground">{online ? "Nothing said in this session yet." : "Waiting for your Mac…"}</p> : null}
				{chat.map((block, i) => (
					<div key={i}>
						{"steps" in block ? (
							<Steps steps={block.steps} running={running && i === chat.length - 1} />
						) : block.e.kind === "you" ? (
							<Message align="end">
								<MessageContent>
									<div className="ml-auto w-fit max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-muted px-3 py-2 text-foreground">{block.e.text}</div>
								</MessageContent>
							</Message>
						) : block.e.kind === "error" ? (
							<p className="rounded-xl bg-red-500/10 px-3 py-2 text-[13px] text-red-700 dark:text-red-400">{block.e.text}</p>
						) : (
							<AgentMessage e={block.e} onBug={() => {}} />
						)}
					</div>
				))}
				{working ? (
					<p className="flex items-center gap-2 text-[13px] text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" /> {working.text}
					</p>
				) : null}
			</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void act(running ? "send" : "start");
				}}
				className={`shrink-0 border-t bg-background px-3 pt-2 ${aboveTabs ? "fm-above-tabs" : "fm-safe-bottom"}`}
			>
				{error ? <p className="mb-2 text-[13px] text-red-600 dark:text-red-400">{error}</p> : null}
				<div className="flex items-end gap-2 rounded-3xl border bg-card p-1.5 pl-4 focus-within:border-foreground/30">
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={1}
						placeholder={running ? "Message the swarm" : "What should it focus on? (optional)"}
						className="max-h-32 min-h-[36px] flex-1 resize-none bg-transparent py-1.5 outline-none placeholder:text-muted-foreground"
					/>
					<button type="submit" disabled={!!busy || !online || (running && !text.trim())} aria-label={running ? "Send" : "Start the swarm"} className="grid size-9 shrink-0 place-items-center rounded-full bg-foreground text-background disabled:opacity-40">
						{busy === "send" ? <Loader2 className="size-4 animate-spin" /> : running ? <ArrowUp className="size-4" /> : <Play className="size-4 fill-current" />}
					</button>
				</div>
			</form>
		</>
	);
}
