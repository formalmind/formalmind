import { useNavigate } from "react-router";
import { Bell } from "lucide-react";
import { dismissNotification, markNotificationRead, useNotifications, type StoreNotification } from "@/lib/notifications";
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

function Row({ n }: { n: StoreNotification }) {
	const navigate = useNavigate();
	const path = pathOf(n);
	return (
		<li>
			<button
				type="button"
				onClick={() => {
					markNotificationRead(n.id);
					if (path) navigate(path);
				}}
				className="flex w-full items-start gap-3 px-3 py-3 text-left active:bg-muted"
			>
				<span className="min-w-0 flex-1">
					<span className={`block text-[15px] font-medium ${n.read ? "text-foreground/80" : TONE[n.variant]}`}>{n.title}</span>
					{n.description ? <span className="mt-0.5 line-clamp-2 block text-[13px] text-muted-foreground">{n.description}</span> : null}
				</span>
				<span className="shrink-0 text-[12px] text-muted-foreground">{ago(n.createdAt)}</span>
			</button>
		</li>
	);
}

function Frame({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="rounded-2xl border bg-muted/60 p-1.5">
			<header className="flex h-8 items-center px-2.5">
				<h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
				{aside ? <span className="ml-auto">{aside}</span> : null}
			</header>
			<ul className="shadow-card divide-y overflow-hidden rounded-xl border bg-card">{children}</ul>
		</section>
	);
}

/** Notifications: the unread ones, then the earlier ones; one opens what it's about and counts as read. */
export function NotificationsScreen() {
	const all = useNotifications();
	const unread = all.filter((n) => !n.read);
	const earlier = all.filter((n) => n.read);
	return (
		<div className="min-h-dvh bg-background">
			<TopBar back={true} title="Notifications" sub={unread.length ? `${unread.length} unread` : "All read"} />
			<main className="fm-safe-bottom space-y-5 px-4 py-4">
				{all.length === 0 ? <p className="pt-10 text-center text-[15px] text-muted-foreground">Nothing yet. A proof done, a bug filed or a budget reached shows here.</p> : null}
				{unread.length ? (
					<Frame
						label="Unread"
						aside={
							<button type="button" onClick={() => unread.forEach((n) => markNotificationRead(n.id))} className="text-[13px] text-muted-foreground active:text-foreground">
								Mark all read
							</button>
						}
					>
						{unread.map((n) => (
							<Row key={n.id} n={n} />
						))}
					</Frame>
				) : null}
				{earlier.length ? (
					<Frame
						label="Earlier"
						aside={
							<button type="button" onClick={() => earlier.forEach((n) => dismissNotification(n.id))} className="text-[13px] text-muted-foreground active:text-foreground">
								Clear
							</button>
						}
					>
						{earlier.map((n) => (
							<Row key={n.id} n={n} />
						))}
					</Frame>
				) : null}
			</main>
		</div>
	);
}
