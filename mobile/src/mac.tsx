import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { notify, useNotifications } from "@/lib/notifications";
import { ArrowUp, Bell, ChevronRight, Folder, Laptop, Play, Settings, Square } from "lucide-react";
import { BellLink } from "./notifications";
import { Message, MessageContent } from "@/components/ui/message";
import { AgentMessage, blocks, Steps, type Ev } from "@/desktop/src/swarm-panel";
import { CenterState, FloatingBar, GlassDivider, GlassSegment, Skeleton, TopBar } from "./bar";
import { hasHistory, macOnline, send, startBudget, useMac, useSession } from "./relay";

/** Whether this stretch of the Mac being offline has had its notice. */
let offlineNoted = false;

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

/** Why there's nothing from your Mac, centered: still connecting, never connected, offline, or no folders. Null when
 * there is something to show. */
/** A conversation's shape while it loads: agent lines on the left, one of yours on the right. */
function ChatSkeleton() {
	return (
		<div aria-label="Loading" className="w-full space-y-6 pt-2">
			{[0, 1, 2].map((i) => (
				<div key={i} className="space-y-2.5">
					<Skeleton className="h-3 w-20" />
					<Skeleton className="h-4 w-11/12" />
					<Skeleton className="h-4 w-4/5" />
					<Skeleton className="h-4 w-2/3" />
					{i === 1 ? <Skeleton className="ml-auto mt-5 h-12 w-3/5 rounded-2xl" /> : null}
				</div>
			))}
		</div>
	);
}

export function MacState() {
	const m = useMac();
	const icon = <Laptop className="size-7" strokeWidth={1.6} />;
	if (!m.loaded) return <ChatSkeleton />;
	if (!m.state)
		return (
			<CenterState
				icon={icon}
				muted="The swarm runs on your Mac."
				strong="Connect it here."
				body="Open Formal Mind on your Mac and sign in with this account. Keep Settings → Phone on, and its sessions show up here."
			/>
		);
	if (!macOnline(m))
		return <CenterState icon={icon} muted="Your Mac is offline." strong="Open Formal Mind there." body="Messages you send wait 10 minutes for it. Its sessions so far are below once it's back." />;
	if (!m.state.folders.length) return <CenterState icon={icon} muted="No folders on your Mac yet." strong="Add one there." body="A folder you add in Formal Mind on your Mac shows up here, with its swarm sessions." />;
	return null;
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
			{!m.state?.folders.length ? <div className="flex min-h-[70dvh] flex-col"><MacState /></div> : <Offline />}
			<main className="fm-safe-bottom space-y-5 px-4 py-4">
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
	// Your Mac going away is a notice in the bell (once each time), not a banner over the chat.
	useEffect(() => {
		if (online) offlineNoted = false;
		if (!m.loaded || !m.state || online || offlineNoted) return;
		offlineNoted = true;
		notify.info("Your Mac is offline", { id: "mac-offline", description: "Messages wait up to 10 minutes for it; open Formal Mind there to carry on." });
	}, [m.loaded, !!m.state, online]);
	// What you've sent that the Mac hasn't echoed yet: shown at once, marked as waiting while the Mac is away.
	const [pending, setPending] = useState<string[]>([]);
	useEffect(() => {
		if (!pending.length) return;
		const left = pending.filter((t) => !events.some((e) => e.kind === "you" && e.text.trim() === t));
		if (left.length !== pending.length) setPending(left);
	}, [events, pending]);

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
		setBusy(kind);
		try {
			if (kind === "send") {
				const t = text.trim();
				if (!t) return;
				setText("");
				setPending((p) => [...p, t]);
				try {
					await send({ type: "say", folder, run, text: t });
				} catch (e) {
					setPending((p) => p.filter((x) => x !== t));
					setText(t);
					throw e;
				}
				atBottom.current = true;
			} else if (kind === "start") {
				// Resuming carries on this session's queue on the Mac; the cap goes above what it has spent, or a session that
				// reached its budget would stop again at once.
				const cap = startBudget() ?? 5;
				await send({ type: "start", folder, run, goal: text.trim() || undefined, budget: resumable ? Math.ceil(spent + cap) : cap });
				setText("");
			} else await send({ type: "stop", folder, run });
		} catch (e) {
			// Errors go to the bell, not into the conversation.
			notify.error(kind === "send" ? "Your message didn't go" : kind === "stop" ? "Couldn't stop the swarm" : "Couldn't start the swarm", { description: e instanceof Error ? e.message : String(e) });
		} finally {
			setBusy(null);
		}
	};

	// One button, as in Mike's composer: Send with text; Stop while it works and the box is empty; Start or Resume when
	// it's stopped.
	const action: "send" | "stop" | "start" = running || (!online && text.trim()) ? (text.trim() ? "send" : "stop") : "start";
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
				{chat.length === 0 && online && asked.current && !hasHistory(folder, run) && resumable ? <ChatSkeleton /> : chat.length === 0 ? (
					<div className="flex min-h-[55dvh] flex-col">
						{online ? (
							<CenterState icon={<Laptop className="size-7" strokeWidth={1.6} />} muted={resumable ? "This session is paused." : "A new session."} strong={resumable ? "Resume it below." : "Tell it what to focus on."} body="It runs on your Mac; what its agents say shows here as they work." />
						) : (
							<MacState />
						)}
					</div>
				) : null}
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
				{pending.map((t, i) => (
					<Message key={`p${i}`} align="end">
						<MessageContent>
							<div className="fm-bubble ml-10 w-fit whitespace-pre-wrap rounded-2xl p-3 text-foreground">{t}</div>
							<p className="mt-1 text-right text-[12px] text-muted-foreground">{online ? "Sent" : "Waiting for your Mac"}</p>
						</MessageContent>
					</Message>
				))}
				{working ? (
					<p className="fm-shimmer-text text-[14px]">{working.text}</p>
				) : null}
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
						<button
							type="submit"
							disabled={!!busy || (action === "send" && !text.trim())}
							aria-label={action === "send" ? "Send" : action === "stop" ? "Stop the swarm" : resumable ? "Resume the swarm" : "Start the swarm"}
							className={`ml-auto inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-full bg-foreground text-[13px] font-medium text-background disabled:opacity-40 ${action === "start" ? "px-3.5" : "w-8"}`}
						>
							{action === "send" ? (
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
