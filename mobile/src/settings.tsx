import { useState } from "react";
import { useNavigate } from "react-router";
import { useTheme } from "next-themes";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, LogOut } from "lucide-react";
import { apiBase, DEFAULT_API, setApiBase } from "@/desktop/src/api";
import { BUILD } from "@/lib/build-info";
import type { SessionData } from "@/lib/session";
import { TopBar } from "./bar";
import { setIntroduced } from "./onboarding";
import { setSetUpDone } from "./setup";
import { macOnline, NOTICES, noticeOn, setNotice, useMac } from "./relay";
import { lastProject, TabBar } from "./tabs";

/** A group of rows, iOS style: a caption over a rounded card, an optional note under it. */
function Group({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section>
			<h2 className="mb-1.5 px-4 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
			<div className="divide-y overflow-hidden rounded-2xl border bg-card shadow-card">{children}</div>
			{note ? <p className="mt-1.5 px-4 text-[12px] leading-5 text-muted-foreground">{note}</p> : null}
		</section>
	);
}

const row = "flex min-h-12 w-full items-center gap-3 px-4 py-2.5 text-left text-[15px]";

function Toggle({ label, sub, on, onChange }: { label: string; sub?: string; on: boolean; onChange: (on: boolean) => void }) {
	return (
		<label className={row}>
			<span className="min-w-0 flex-1">
				<span className="block">{label}</span>
				{sub ? <span className="block text-[12px] text-muted-foreground">{sub}</span> : null}
			</span>
			<input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} className="fm-switch" />
		</label>
	);
}

/** Settings: your account, your Mac, notifications, appearance, the server, and the introduction again. */
export function SettingsScreen({ user, onSignOut }: { user: SessionData["user"]; onSignOut: () => void }) {
	const navigate = useNavigate();
	const m = useMac();
	const online = macOnline(m);
	const { theme, setTheme } = useTheme();
	const [notices, setNotices] = useState(() => Object.fromEntries(NOTICES.map((n) => [n.id, noticeOn(n.id)])));
	const [base, setBase] = useState(apiBase());
	const [saved, setSaved] = useState(false);
	const folders = m.state?.folders.length ?? 0;
	return (
		<div className="min-h-dvh bg-muted/40">
			<TopBar back="/" title="Settings" />
			<main className="fm-under-tabs space-y-6 px-4 py-5">
				<Group title="Account">
					<div className={row}>
						<span className="grid size-10 shrink-0 place-items-center overflow-hidden rounded-full border bg-muted font-medium">
							{user.picture ? <img src={user.picture} alt="" className="size-full object-cover" /> : (user.name ?? user.nickname ?? "?").slice(0, 1).toUpperCase()}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate font-medium">{user.name ?? user.nickname}</span>
							<span className="block truncate text-[12px] text-muted-foreground">{user.email ?? (user.nickname ? `@${user.nickname}` : "")}</span>
						</span>
					</div>
					<button type="button" onClick={() => void openUrl(`${apiBase()}/billing`)} className={`${row} active:bg-muted`}>
						<span className="flex-1">Billing and credits</span>
						<ChevronRight className="size-4 text-muted-foreground" />
					</button>
					<button type="button" onClick={onSignOut} className={`${row} text-red-600 active:bg-muted dark:text-red-400`}>
						<LogOut className="size-4" /> Sign out
					</button>
				</Group>

				<Group
					title="Your Mac"
					note="The swarm runs in Formal Mind on your Mac. Sign in there with the same account and keep Settings → Phone on; the phone then follows its sessions and sends your messages, Start and Stop to it."
				>
					<button type="button" onClick={() => navigate("/mac")} className={`${row} active:bg-muted`}>
						<span className={`size-2 shrink-0 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
						<span className="min-w-0 flex-1">
							<span className="block">{!m.loaded ? "Connecting…" : online ? "Online" : m.state ? "Offline" : "Not connected yet"}</span>
							<span className="block text-[12px] text-muted-foreground">{m.state ? `${folders} folder${folders === 1 ? "" : "s"}` : "No Mac has signed in"}</span>
						</span>
						<ChevronRight className="size-4 text-muted-foreground" />
					</button>
				</Group>

				<Group title="Notifications" note="Shown in the app and in the bell while Formal Mind is open.">
					{NOTICES.map((n) => (
						<Toggle
							key={n.id}
							label={n.label}
							sub={n.sub}
							on={notices[n.id]}
							onChange={(on) => {
								setNotice(n.id, on);
								setNotices((all) => ({ ...all, [n.id]: on }));
							}}
						/>
					))}
				</Group>

				<Group title="Appearance">
					<div className="grid grid-cols-3 gap-1 p-1.5">
						{(["system", "light", "dark"] as const).map((t) => (
							<button key={t} type="button" onClick={() => setTheme(t)} className={`h-9 rounded-xl text-[14px] capitalize ${(theme ?? "system") === t ? "bg-muted font-medium" : "text-muted-foreground"}`}>
								{t}
							</button>
						))}
					</div>
				</Group>

				<Group title="Server" note="Change only for development, e.g. http://localhost:8787. Sign in again after changing it.">
					<form
						className={row}
						onSubmit={(e) => {
							e.preventDefault();
							setApiBase(base);
							setSaved(true);
						}}
					>
						<input value={base} onChange={(e) => (setBase(e.target.value), setSaved(false))} placeholder={DEFAULT_API} autoCapitalize="off" autoCorrect="off" inputMode="url" className="min-w-0 flex-1 bg-transparent outline-none" />
						<button type="submit" className="text-[14px] font-medium text-sky-600">{saved ? "Saved" : "Save"}</button>
					</form>
				</Group>

				<Group title="About">
					<button
						type="button"
						onClick={() => {
							setIntroduced(false);
							window.location.reload();
						}}
						className={`${row} active:bg-muted`}
					>
						<span className="flex-1">Show the introduction</span>
						<ChevronRight className="size-4 text-muted-foreground" />
					</button>
					<button
						type="button"
						onClick={() => {
							setSetUpDone(false);
							window.location.reload();
						}}
						className={`${row} active:bg-muted`}
					>
						<span className="flex-1">Run setup again</span>
						<ChevronRight className="size-4 text-muted-foreground" />
					</button>
					<button type="button" onClick={() => void openUrl(`${DEFAULT_API}/terms`)} className={`${row} active:bg-muted`}>
						<span className="flex-1">Terms of Service</span>
						<ChevronRight className="size-4 text-muted-foreground" />
					</button>
					<button type="button" onClick={() => void openUrl(`${DEFAULT_API}/privacy`)} className={`${row} active:bg-muted`}>
						<span className="flex-1">Privacy Policy</span>
						<ChevronRight className="size-4 text-muted-foreground" />
					</button>
					<div className={`${row} text-muted-foreground`}>
						<span className="flex-1">Version</span>
						<span className="font-mono text-[13px]">{BUILD || "dev"}</span>
					</div>
				</Group>
			</main>
			<TabBar active="home" repo={lastProject()} />
		</div>
	);
}
