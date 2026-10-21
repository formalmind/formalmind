import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { useNotifications } from "@/lib/notifications";
import { ArrowUp, Bell, ChevronRight, Folder, Laptop, Loader2, Play, Settings, Square } from "lucide-react";
import { BellLink } from "./notifications";
import { Message, MessageContent } from "@/components/ui/message";
import { AgentMessage, blocks, Steps, type Ev } from "@/desktop/src/swarm-panel";
import { FloatingBar, GlassDivider, GlassSegment, TopBar } from "./bar";
import { hasHistory, macOnline, send, startBudget, useMac, useSession } from "./relay";

const sessionHref = (folder: string, run: string) => `/mac/session?${new URLSearchParams({ folder, run })}`;

/** The chat's floating capsule: notifications (with the unread count) and Settings. */
export function ChatButtons() {
	const navigate = useNavigate();
	const unread = useNotifications().filter((n) => !n.read).length;
	return (
		<>
			<GlassSegment label={unread ? `Notifications, ${unread} unread` : "Notifications"} onClick={() => navigate("/notifications")}>
				<Bell className="size-5" />
				{unread ? <span className="absolute right-0.5 top-2 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">{unread > 99 ? "99+" : unread}</span> : null}
			</GlassSegment>
			<GlassDivider />
			<GlassSegment label="Your Mac" onClick={() => navigate("/mac")}>
				<Laptop className="size-5" />
			</GlassSegment>
			<GlassDivider />
			<GlassSegment label="Settings" onClick={() => navigate("/settings")}>
				<Settings className="size-5" />
			</GlassSegment>
		</>
	);
}

export function Offline({ flush }: { flush?: boolean }) {
	const m = useMac();
	if (!m.loaded || macOnline(m)) return null;
	return (
		<p className={`rounded-xl border bg-muted/60 px-3 py-2 text-[13px] text-muted-foreground ${flush ? "" : "mx-4 mt-3"}`}>
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
			<TopBar back="/" title="Your Mac" sub={!m.loaded ? "Connecting…" : online ? "Online" : "Offline"} right={<BellLink />} />
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
			<FloatingBar back="/mac" right={<ChatButtons />} />
			<SessionChat folder={folder} run={run} fullScreen header={session?.title || (run === "swarm" ? "Swarm" : run)} />
		</div>
	);
}

/**
 * One swarm session: what its agents say, and a composer that talks to it; Start and Stop run on the Mac. `aboveTabs`
 * keeps the composer clear of the floating tab bar (the project's Chat tab).
 */
export function SessionChat({ folder, run, aboveTabs, header, fullScreen }: { folder: string; run: string; aboveTabs?: boolean; header?: React.ReactNode; fullScreen?: boolean }) {
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
	// A session with work behind it resumes where it stopped (paused, the budget reached, or the app quit).
	const resumable = !running && (spent > 0 || events.length > 0);

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
				// Resuming carries on this session's queue on the Mac; the cap goes above what it has spent, or a session that
				// reached its budget would stop again at once.
				const cap = startBudget() ?? 5;
				await send({ type: "start", folder, run, goal: text.trim() || undefined, budget: resumable ? Math.ceil(spent + cap) : cap });
				setText("");
			} else await send({ type: "stop", folder, run });
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setBusy(null);
		}
	};

	// One button, as in Mike's composer: Send with text; Stop while it works and the box is empty; Start or Resume when
	// it's stopped.
	const action: "send" | "stop" | "start" = running ? (text.trim() ? "send" : "stop") : "start";
	return (
		<div className="fm-chat flex min-h-0 flex-1 flex-col">
			<div
				ref={scroller}
				onScroll={(e) => {
					const el = e.currentTarget;
					atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
				}}
				className={`min-h-0 flex-1 space-y-5 overflow-y-auto px-4 pb-6 text-[16px] leading-relaxed ${fullScreen ? "fm-under-floating" : "pt-4"}`}
			>
				{/* In the scroll, so floating controls never cover it. */}
				<Offline flush />
				{chat.length === 0 ? <p className="text-[15px] text-muted-foreground">{online ? "Nothing said in this session yet." : "Waiting for your Mac…"}</p> : null}
				{chat.map((block, i) => (
					<div key={i}>
						{"steps" in block ? (
							<Steps steps={block.steps} running={running && i === chat.length - 1} />
						) : block.e.kind === "you" ? (
							<Message align="end">
								<MessageContent>
									{/* Yours sit in a soft bubble; the agents' replies are plain text. */}
									<div className="fm-bubble ml-10 w-fit whitespace-pre-wrap rounded-2xl p-3 text-foreground">{block.e.text}</div>
								</MessageContent>
							</Message>
						) : block.e.kind === "error" ? (
							<p className="rounded-2xl bg-red-500/10 p-3 text-[14px] text-red-700 dark:text-red-400">{block.e.text}</p>
						) : (
							<AgentMessage e={block.e} onBug={() => {}} />
						)}
					</div>
				))}
				{working ? (
					<p className="flex items-center gap-2 text-[14px] text-muted-foreground">
						<Loader2 className="size-3.5 animate-spin" /> {working.text}
					</p>
				) : null}
				{error ? <p className="rounded-2xl bg-red-500/10 p-3 text-[14px] text-red-700 dark:text-red-400">{error}</p> : null}
			</div>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					void act(action);
				}}
				className={`fm-composer-dock relative shrink-0 px-3 ${aboveTabs ? "fm-above-tabs" : "fm-safe-bottom"}`}
			>
				{/* Concentric: 32px controls, a 12px inset, so the shell's corner is 16 + 12 = 28. */}
				<div className="fm-glass rounded-[28px] p-3">
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						rows={1}
						placeholder={running ? "Message the swarm" : resumable ? "Anything to tell it as it resumes?" : "What should it focus on?"}
						className="block max-h-32 min-h-[28px] w-full resize-none bg-transparent px-1 py-0.5 outline-none placeholder:text-muted-foreground"
					/>
					<div className="mt-2 flex items-center gap-2">
						<span className="inline-flex h-8 min-w-0 items-center rounded-full bg-foreground/[0.06] px-3 text-[13px] font-medium">
							<span className="min-w-0 truncate">{header ?? (running ? "Running" : resumable ? "Paused" : "New session")}</span>
						</span>
						<span className="ml-auto shrink-0 font-mono text-[12px] text-muted-foreground">${spent.toFixed(2)}</span>
						<button
							type="submit"
							disabled={!!busy || !online}
							aria-label={action === "send" ? "Send" : action === "stop" ? "Stop the swarm" : resumable ? "Resume the swarm" : "Start the swarm"}
							className={`inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-foreground text-[13px] font-medium text-background disabled:opacity-40 ${action === "start" ? "px-3.5" : "w-8"}`}
						>
							{busy ? (
								<Loader2 className="size-4 animate-spin" />
							) : action === "send" ? (
								<ArrowUp className="size-4" />
							) : action === "stop" ? (
								<Square className="size-3 fill-current" />
							) : (
								<>
									<Play className="size-3 fill-current" /> {resumable ? "Resume" : "Start"}
								</>
							)}
						</button>
					</div>
				</div>
			</form>
		</div>
	);
}
