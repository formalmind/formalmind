import { useState } from "react";
import { Link } from "react-router";
import { MarkGithubIcon } from "@primer/octicons-react";
import { ChevronRight, LogOut, Laptop, Plus } from "lucide-react";
import { AddProjectCard } from "@/components/add-project";
import { HomeEmpty } from "@/components/home-empty";
import { LogoMark } from "@/components/logo";
import { NotificationCenter } from "@/components/notification-center";
import { projectPath, useProjects } from "@/components/projects/use-projects";
import type { SessionData } from "@/lib/session";
import { TopBar } from "./bar";
import { macOnline, useMac } from "./relay";
import { lastProject, TabBar } from "./tabs";

const card = "rounded-2xl border bg-card shadow-card";

/** Your Mac: whether it's online, and how many swarms it's running. */
function MacCard() {
	const m = useMac();
	const online = macOnline(m);
	const running = m.state?.folders.reduce((n, f) => n + f.sessions.filter((s) => s.running).length, 0) ?? 0;
	return (
		<Link to="/mac" className={`${card} flex items-center gap-3 p-4 active:bg-muted`}>
			<span className="grid size-10 shrink-0 place-items-center rounded-xl bg-muted">
				<Laptop className="size-5 text-muted-foreground" />
			</span>
			<span className="min-w-0 flex-1">
				<span className="block font-medium">Swarm on your Mac</span>
				<span className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
					<span className={`size-2 rounded-full ${online ? "bg-emerald-500" : "bg-muted-foreground/40"}`} />
					{!m.loaded ? "Connecting…" : online ? (running ? `${running} running` : "Online, nothing running") : m.state ? "Offline: open Formal Mind on your Mac" : "Not set up: sign in to the Mac app"}
				</span>
			</span>
			<ChevronRight className="size-4 text-muted-foreground" />
		</Link>
	);
}

/**
 * Home: the empty state the Mac app and the website open on (the headline and the next step: add a repository), then
 * your projects and the swarm on your Mac.
 */
export function MobileHome({ user, onSignOut }: { user: SessionData["user"]; onSignOut: () => void }) {
	const projects = useProjects();
	const [adding, setAdding] = useState(false);
	const [menu, setMenu] = useState(false);
	const none = projects?.length === 0;
	return (
		<div className="flex min-h-dvh flex-col bg-background">
			<TopBar
				left={<LogoMark size={26} />}
				title="Formal Mind"
				right={
					<>
						<NotificationCenter />
						<button type="button" onClick={() => setMenu((v) => !v)} aria-label="Account" className="grid size-9 place-items-center overflow-hidden rounded-full border bg-muted text-[13px] font-medium">
							{user.picture ? <img src={user.picture} alt="" className="size-full object-cover" /> : (user.name ?? user.nickname ?? "?").slice(0, 1).toUpperCase()}
						</button>
					</>
				}
			/>
			{menu ? (
				<div className="absolute right-3 top-[calc(env(safe-area-inset-top)+3.25rem)] z-40 w-56 rounded-xl border bg-popover p-1 shadow-pop">
					<p className="truncate px-3 py-2 text-[13px] text-muted-foreground">{user.name ?? user.nickname}</p>
					<button type="button" onClick={onSignOut} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm active:bg-muted">
						<LogOut className="size-4" /> Sign out
					</button>
				</div>
			) : null}
			<main className="fm-home fm-under-tabs flex flex-1 flex-col" onClick={() => setMenu(false)}>
				<HomeEmpty muted="Bugs, proofs and code." strong={none ? "Open a repository." : "Pick a project."}>
					{none || adding ? (
						<AddProjectCard remoteOnly onCancel={none ? undefined : () => setAdding(false)} onDone={() => setAdding(false)} />
					) : (
						<button type="button" onClick={() => setAdding(true)} className="btn-soft inline-flex h-10 w-full items-center justify-center gap-1.5 text-[14px] font-medium">
							<Plus className="size-4" /> Add a project
						</button>
					)}
				</HomeEmpty>
				<div className="space-y-5 px-4">
					{projects?.length ? (
						<section>
							<h2 className="mb-2 px-1 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Projects</h2>
							<ul className={`${card} divide-y overflow-hidden`}>
								{projects.map((p) => (
									<li key={p.repo}>
										<Link to={projectPath(p.repo)} className="flex items-center gap-3 px-4 py-3 active:bg-muted">
											<MarkGithubIcon size={18} className="shrink-0 text-muted-foreground" />
											<span className="min-w-0 flex-1">
												<span className="block truncate font-medium">{p.repo.split("/")[1]}</span>
												<span className="block truncate text-[12px] text-muted-foreground">{p.repo.split("/")[0]}</span>
											</span>
											<ChevronRight className="size-4 text-muted-foreground" />
										</Link>
									</li>
								))}
							</ul>
						</section>
					) : null}
					<MacCard />
				</div>
			</main>
			<TabBar active="home" repo={lastProject()} />
		</div>
	);
}
