import { useState } from "react";
import { useNavigate } from "react-router";
import { useTheme } from "next-themes";
import { openUrl } from "@tauri-apps/plugin-opener";
import { BadgeCheck, Bell, Bug, ChevronRight, ChevronsUpDown, CreditCard, FileText, Info, Laptop, LogOut, RotateCcw, Server, Shield, Sparkles, SunMoon, Wallet } from "lucide-react";
import { apiBase, DEFAULT_API, setApiBase } from "@/desktop/src/api";
import { BUILD } from "@/lib/build-info";
import type { SessionData } from "@/lib/session";
import { TopBar } from "./bar";
import { setIntroduced } from "./onboarding";
import { setSetUpDone } from "./setup";
import { macName, macOnline, NOTICES, noticeOn, setNotice, useMac } from "./relay";
import { lastProject, TabBar } from "./tabs";

/** A group of rows as iOS draws Settings (the askmike app's): a caption over a rounded card, a note under it. */
function Group({ title, note, children }: { title?: string; note?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section>
			{title ? <h2 className="mb-1.5 px-5 text-[13px] uppercase text-muted-foreground">{title}</h2> : null}
			<div className="overflow-hidden rounded-[22px] bg-card shadow-card [&>*+*]:relative [&>*+*]:before:absolute [&>*+*]:before:left-[60px] [&>*+*]:before:right-0 [&>*+*]:before:top-0 [&>*+*]:before:h-px [&>*+*]:before:bg-border">
				{children}
			</div>
			{note ? <p className="mt-1.5 px-5 text-[13px] leading-[18px] text-muted-foreground">{note}</p> : null}
		</section>
	);
}

/** The coloured tile beside a row's label, a white glyph on it. */
function Tile({ icon: Icon, color }: { icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; color: string }) {
	return (
		<span className={`grid size-[29px] shrink-0 place-items-center rounded-[7px] text-white ${color}`}>
			<Icon className="size-[17px]" strokeWidth={2.2} />
		</span>
	);
}

const row = "flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-left text-[17px]";

/** A row: tile, label (and a line under it), a value, and a chevron when it opens something. */
function Row({ icon, color, label, sub, value, onClick, chevron = !!onClick, className = "" }: { icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; color: string; label: React.ReactNode; sub?: React.ReactNode; value?: React.ReactNode; onClick?: () => void; chevron?: boolean; className?: string }) {
	const body = (
		<>
			<Tile icon={icon} color={color} />
			<span className="min-w-0 flex-1">
				<span className="block truncate">{label}</span>
				{sub ? <span className="block truncate text-[13px] text-muted-foreground">{sub}</span> : null}
			</span>
			{value != null ? <span className="shrink-0 text-[17px] text-muted-foreground">{value}</span> : null}
			{chevron ? <ChevronRight className="size-[18px] shrink-0 text-muted-foreground/60" strokeWidth={2.4} /> : null}
		</>
	);
	return onClick ? (
		<button type="button" onClick={onClick} className={`${row} active:bg-muted ${className}`}>
			{body}
		</button>
	) : (
		<div className={`${row} ${className}`}>{body}</div>
	);
}

function Toggle({ icon, color, label, sub, on, onChange }: { icon: React.ComponentType<{ className?: string; strokeWidth?: number }>; color: string; label: string; sub?: string; on: boolean; onChange: (on: boolean) => void }) {
	return (
		<label className={row}>
			<Tile icon={icon} color={color} />
			<span className="min-w-0 flex-1">
				<span className="block">{label}</span>
				{sub ? <span className="block text-[13px] text-muted-foreground">{sub}</span> : null}
			</span>
			<input type="checkbox" role="switch" checked={on} onChange={(e) => onChange(e.target.checked)} className="fm-switch" />
		</label>
	);
}

const NOTICE_TILE: Record<string, [React.ComponentType<{ className?: string; strokeWidth?: number }>, string]> = {
	proof: [BadgeCheck, "bg-emerald-500"],
	bug: [Bug, "bg-red-500"],
	budget: [Wallet, "bg-orange-500"],
};

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
		<div className="min-h-dvh bg-muted/50">
			<TopBar back="/" title="Settings" />
			<main className="fm-under-tabs space-y-7 px-4 py-5">
				<Group>
					<div className="flex w-full items-center gap-3.5 px-4 py-3.5">
						<span className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[22px] font-medium">
							{user.picture ? <img src={user.picture} alt="" className="size-full object-cover" /> : (user.name ?? user.nickname ?? "?").slice(0, 1).toUpperCase()}
						</span>
						<span className="min-w-0 flex-1">
							<span className="block truncate text-[20px] font-semibold">{user.name ?? user.nickname}</span>
							<span className="block truncate text-[15px] text-muted-foreground">{user.email ?? (user.nickname ? `@${user.nickname}` : "")}</span>
						</span>
					</div>
				</Group>

				<Group title="Account">
					<Row icon={CreditCard} color="bg-blue-500" label="Billing and credits" onClick={() => void openUrl(`${apiBase()}/billing`)} />
				</Group>

				<Group
					title="Your Mac"
					note="The swarm runs in Formal Mind on your Mac. Sign in there with the same account and keep Settings → Phone on; the phone then follows its sessions and sends your messages, Start and Stop to it."
				>
					<Row
						icon={Laptop}
						color={online ? "bg-emerald-500" : "bg-neutral-400 dark:bg-neutral-600"}
						label={macName(m)}
						sub={m.state ? `${folders} folder${folders === 1 ? "" : "s"}` : "No Mac has signed in"}
						value={!m.loaded ? "Connecting…" : online ? "Online" : m.state ? "Offline" : "Not connected"}
						onClick={() => navigate("/mac")}
					/>
				</Group>

				<Group title="Notifications" note="Shown in the app and in the bell while Formal Mind is open.">
					{NOTICES.map((n) => {
						const [icon, color] = NOTICE_TILE[n.id] ?? [Bell, "bg-red-500"];
						return (
							<Toggle
								key={n.id}
								icon={icon}
								color={color}
								label={n.label}
								sub={n.sub}
								on={notices[n.id]}
								onChange={(on) => {
									setNotice(n.id, on);
									setNotices((all) => ({ ...all, [n.id]: on }));
								}}
							/>
						);
					})}
				</Group>

				<Group title="General" note="Change the server only for development (e.g. http://localhost:8787), then sign in again.">
					{/* A picker row, as iOS shows one: the choice on the right, the menu over the row. */}
					<label className={`${row} relative`}>
						<Tile icon={SunMoon} color="bg-indigo-500" />
						<span className="flex-1">Appearance</span>
						<span className="flex items-center gap-1 text-muted-foreground capitalize">
							{theme ?? "system"}
							<ChevronsUpDown className="size-4" />
						</span>
						<select value={theme ?? "system"} onChange={(e) => setTheme(e.target.value)} className="absolute inset-0 opacity-0" aria-label="Appearance">
							<option value="system">System</option>
							<option value="light">Light</option>
							<option value="dark">Dark</option>
						</select>
					</label>
					<form
						className={row}
						onSubmit={(e) => {
							e.preventDefault();
							setApiBase(base);
							setSaved(true);
						}}
					>
						<Tile icon={Server} color="bg-neutral-500" />
						<input value={base} onChange={(e) => (setBase(e.target.value), setSaved(false))} placeholder={DEFAULT_API} autoCapitalize="off" autoCorrect="off" inputMode="url" className="min-w-0 flex-1 bg-transparent outline-none" aria-label="Server" />
						<button type="submit" className="text-[17px] text-sky-600">{saved ? "Saved" : "Save"}</button>
					</form>
				</Group>

				<Group title="About">
					<Row
						icon={Sparkles}
						color="bg-violet-500"
						label="Show the introduction"
						onClick={() => {
							setIntroduced(false);
							window.location.reload();
						}}
					/>
					<Row
						icon={RotateCcw}
						color="bg-sky-500"
						label="Run setup again"
						onClick={() => {
							setSetUpDone(false);
							window.location.reload();
						}}
					/>
					<Row icon={FileText} color="bg-neutral-500" label="Terms of Service" onClick={() => void openUrl(`${DEFAULT_API}/terms`)} />
					<Row icon={Shield} color="bg-neutral-500" label="Privacy Policy" onClick={() => void openUrl(`${DEFAULT_API}/privacy`)} />
					<Row icon={Info} color="bg-neutral-500" label="Version" value={<span className="font-mono text-[15px]">{BUILD || "dev"}</span>} />
				</Group>

				<Group>
					<button type="button" onClick={onSignOut} className={`${row} justify-center text-red-600 active:bg-muted dark:text-red-400`}>
						<LogOut className="size-[18px]" /> Sign out
					</button>
				</Group>
			</main>
			<TabBar active="home" repo={lastProject()} />
		</div>
	);
}
