import { useNavigate, useParams } from "react-router";
import { Bell, Check, ChevronRight, Copy, MessageSquare } from "lucide-react";
import { useState } from "react";
import { dismissNotification, markNotificationRead, markNotificationUnread, useNotifications, type StoreNotification } from "@/lib/notifications";
import { TopBar } from "./bar";

/** A notice's link: its action event is "fm:go:<path>" (./relay.ts), the screen it is about. */
const pathOf = (n: StoreNotification) => (n.action?.event.startsWith("fm:go:") ? n.action.event.slice(6) : null);

const ago = (ms: number) => {
	const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
	if (s < 60) return "now";
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
};

const TONE: Record<StoreNotification["variant"], string> = {
	success: "text-emerald-600 dark:text-emerald-400",
	error: "text-red-600 dark:text-red-400",
	warning: "text-amber-600 dark:text-amber-400",
	info: "text-foreground",
};

/** The bell in the top bars: the unread count, and the notifications page. */
export function BellLink() {
	const navigate = useNavigate();
	const unread = useNotifications().filter((n) => !n.read).length;
	return (
		<button type="button" onClick={() => navigate("/notifications")} aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"} className="relative grid size-9 place-items-center rounded-full border text-muted-foreground active:bg-muted">
			<Bell className="size-4" />
			{unread ? <span className="absolute -right-1 -top-1 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">{unread > 99 ? "99+" : unread}</span> : null}
		</button>
	);
}

type Filter = "unread" | "read" | "all";
const FILTERS: { id: Filter; label: string }[] = [
	{ id: "unread", label: "Unread" },
	{ id: "read", label: "Read" },
	{ id: "all", label: "History" },
];

const day = (ms: number) => {
	const d = new Date(ms);
	const today = new Date();
	const yesterday = new Date(Date.now() - 86_400_000);
	if (d.toDateString() === today.toDateString()) return "Today";
	if (d.toDateString() === yesterday.toDateString()) return "Yesterday";
	return d.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
};

/** One notice: unread ones in their colour and bold with an Unread tag; read ones quiet. Tap opens it; the button flips it. */
function Row({ n }: { n: StoreNotification }) {
	const navigate = useNavigate();
	return (
		<li className={n.read ? "" : "bg-foreground/[0.035]"}>
			<div className="flex items-start gap-3 px-3 py-3">
				<button
					type="button"
					onClick={() => {
						markNotificationRead(n.id);
						navigate(`/notifications/${encodeURIComponent(String(n.id))}`);
					}}
					className="min-w-0 flex-1 text-left active:opacity-60"
				>
					<span className={`block text-[15px] ${n.read ? "text-muted-foreground" : `font-semibold ${TONE[n.variant]}`}`}>{n.title}</span>
					{n.description ? <span className={`mt-0.5 line-clamp-2 block text-[13px] ${n.read ? "text-muted-foreground/70" : "text-muted-foreground"}`}>{n.description}</span> : null}
				</button>
				<span className="flex shrink-0 flex-col items-end gap-1.5">
					<span className="text-[12px] text-muted-foreground">{ago(n.createdAt)}</span>
					<button
						type="button"
						onClick={() => (n.read ? markNotificationUnread(n.id) : markNotificationRead(n.id))}
						className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${n.read ? "text-muted-foreground active:bg-muted" : "bg-foreground text-background"}`}
					>
						{n.read ? "Mark unread" : "Unread"}
					</button>
				</span>
			</div>
		</li>
	);
}

/** Notifications: Unread, Read, or the whole History by day (the floating filter); one opens what it's about. */
export function NotificationsScreen() {
	const all = useNotifications();
	const unreadCount = all.filter((n) => !n.read).length;
	const [filter, setFilter] = useState<Filter>(() => (unreadCount ? "unread" : "all"));
	const shown = all.filter((n) => (filter === "unread" ? !n.read : filter === "read" ? n.read : true));
	const days = shown.reduce<{ day: string; items: StoreNotification[] }[]>((out, n) => {
		const d = day(n.createdAt);
		if (out.at(-1)?.day === d) out.at(-1)!.items.push(n);
		else out.push({ day: d, items: [n] });
		return out;
	}, []);
	const empty = { unread: "No unread notifications.", read: "Nothing read yet.", all: "Nothing yet. A proof done, a bug filed or a budget reached shows here." }[filter];
	return (
		<div className="min-h-dvh bg-background">
			<TopBar
				back={true}
				title="Notifications"
				sub={unreadCount ? `${unreadCount} unread` : "All read"}
				right={
					filter === "unread" && unreadCount ? (
						<button type="button" onClick={() => all.forEach((n) => !n.read && markNotificationRead(n.id))} className="px-2 text-[14px] font-medium text-sky-600 dark:text-sky-400">
							Mark all read
						</button>
					) : filter !== "unread" && shown.length ? (
						<button type="button" onClick={() => shown.filter((n) => n.read).forEach((n) => dismissNotification(n.id))} className="px-2 text-[14px] text-muted-foreground">
							Clear read
						</button>
					) : null
				}
			/>
			<main className="fm-under-tabs space-y-5 px-4 py-4">
				{shown.length === 0 ? <p className="pt-10 text-center text-[15px] text-muted-foreground">{empty}</p> : null}
				{days.map((g) => (
					<section key={g.day} className="rounded-2xl border bg-muted/60 p-1.5">
						<header className="flex h-8 items-center px-2.5">
							<h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{g.day}</h2>
							<span className="ml-auto text-[12px] text-muted-foreground">{g.items.length}</span>
						</header>
						<ul className="shadow-card divide-y overflow-hidden rounded-xl border bg-card">
							{g.items.map((n) => (
								<Row key={n.id} n={n} />
							))}
						</ul>
					</section>
				))}
			</main>
			<nav aria-label="Show" className="fm-safe-bottom pointer-events-none fixed inset-x-0 bottom-0 z-30 flex justify-center">
				<div className="fm-glass pointer-events-auto mb-1 flex items-center rounded-full p-1">
					{FILTERS.map((f) => (
						<button key={f.id} type="button" onClick={() => setFilter(f.id)} aria-pressed={filter === f.id} className={`h-11 rounded-full px-5 text-[14px] font-medium ${filter === f.id ? "bg-foreground/[0.08] text-foreground" : "text-muted-foreground"}`}>
							{f.label}
							{f.id === "unread" && unreadCount ? <span className="ml-1.5 rounded-full bg-red-600 px-1.5 py-px text-[11px] font-semibold text-white">{unreadCount}</span> : null}
						</button>
					))}
				</div>
			</nav>
		</div>
	);
}

/** One notification in full: what happened, where and when; copy it, open its session, or keep it unread. */
export function NotificationScreen() {
	const { id } = useParams();
	const navigate = useNavigate();
	const n = useNotifications().find((x) => String(x.id) === id);
	const [copied, setCopied] = useState(false);
	if (!n) {
		return (
			<div className="min-h-dvh bg-background">
				<TopBar back={true} title="Notification" />
				<p className="p-6 text-center text-[15px] text-muted-foreground">This notification was cleared.</p>
			</div>
		);
	}
	const path = pathOf(n);
	const where = path ? new URLSearchParams(path.split("?")[1]) : null;
	const text = n.copy ?? [n.title, n.description].filter(Boolean).join("\n\n");
	const row = "flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left text-[15px] active:bg-muted";
	return (
		<div className="min-h-dvh bg-background">
			<TopBar back={true} title="Notification" sub={new Date(n.createdAt).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })} />
			<main className="fm-safe-bottom space-y-5 px-4 py-4">
				<section className="rounded-2xl border bg-muted/60 p-1.5">
					<header className="flex h-8 items-center px-2.5">
						<h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{{ success: "Proof", error: "Bug or error", warning: "Budget", info: "Swarm" }[n.variant]}</h2>
						<span className="ml-auto text-[12px] text-muted-foreground">{n.read ? "Read" : "Unread"}</span>
					</header>
					<div className="shadow-card rounded-xl border bg-card p-4">
						<h1 className={`text-[19px] font-semibold leading-snug ${TONE[n.variant]}`}>{n.title}</h1>
						<p className="mt-3 select-text whitespace-pre-wrap break-words text-[15px] leading-relaxed">{n.copy?.split("\n\n")[0] ?? n.description}</p>
						{where ? (
							<dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-t pt-3 text-[13px]">
								<dt className="text-muted-foreground">Folder</dt>
								<dd className="min-w-0 truncate font-mono">{where.get("folder")}</dd>
								<dt className="text-muted-foreground">Session</dt>
								<dd className="font-mono">{where.get("run")}</dd>
							</dl>
						) : null}
					</div>
				</section>
				<div className="divide-y overflow-hidden rounded-2xl border bg-card shadow-card">
					<button
						type="button"
						onClick={() =>
							void navigator.clipboard.writeText(text).then(() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 1500);
							})
						}
						className={row}
					>
						{copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
						<span className="flex-1">{copied ? "Copied" : "Copy"}</span>
					</button>
					{path ? (
						<button type="button" onClick={() => navigate(path)} className={row}>
							<MessageSquare className="size-4" />
							<span className="flex-1">Open the session</span>
							<ChevronRight className="size-4 text-muted-foreground" />
						</button>
					) : null}
					<button
						type="button"
						onClick={() => {
							markNotificationUnread(n.id);
							navigate(-1);
						}}
						className={row}
					>
						<Bell className="size-4" />
						<span className="flex-1">Keep as unread</span>
					</button>
				</div>
			</main>
		</div>
	);
}
