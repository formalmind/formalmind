import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { MarkGithubIcon } from "@primer/octicons-react";
import { ChevronRight, Laptop, Plus } from "lucide-react";
import { AddProjectCard } from "@/components/add-project";
import { HomeEmpty } from "@/components/home-empty";
import { LogoMark } from "@/components/logo";
import { BellLink } from "./notifications";
import { projectPath, useProjects } from "@/components/projects/use-projects";
import type { SessionData } from "@/lib/session";
import { Skeleton, TopBar } from "./bar";
import { macName, macOnline, useMac } from "./relay";
import { lastProject, TabBar } from "./tabs";


/**
 * At most four projects, the one you last opened first and then the newest added, so Home's other cards keep their
 * room (setup's list too).
 */
export function recentProjects<T extends { repo: string; addedAt: string }>(projects: T[], n = 4): T[] {
	const last = lastProject();
	return [...projects].sort((a, b) => Number(b.repo === last) - Number(a.repo === last) || b.addedAt.localeCompare(a.addedAt)).slice(0, n);
}

/** The app's card: a grey frame with its label on top, the content on a white card inside (as on the Mac and the web). */
export function FrameCard({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="rounded-2xl border bg-muted/60 p-1.5">
			<header className="flex h-8 items-center px-2.5">
				<h2 className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</h2>
				{aside ? <span className="ml-auto text-[12px] text-muted-foreground">{aside}</span> : null}
			</header>
			<div className="shadow-card overflow-hidden rounded-xl border bg-card">{children}</div>
		</section>
	);
}

/** Your Mac: whether it's online, and how many swarms it's running. */
function MacCard() {
	const m = useMac();
	const online = macOnline(m);
	const running = m.state?.folders.reduce((n, f) => n + f.sessions.filter((s) => s.running).length, 0) ?? 0;
	return (
		<Link to="/mac" className="block active:opacity-80">
			<MacCardView
				name={macName(m)}
				status={online ? "Online" : m.loaded ? "Offline" : null}
				title={running ? `${running} session${running === 1 ? "" : "s"} running` : "Nothing running"}
				hint={!m.loaded ? <Skeleton className="mt-1 h-3 w-40" /> : online ? "Follow and steer it from here" : m.state ? "Open Formal Mind on your Mac" : "Sign in to the Mac app to connect it"}
			/>
		</Link>
	);
}

/** The Your Mac card as Home draws it (the introduction shows it too). */
export function MacCardView({ status, title, hint, name = "Your Mac" }: { status: string | null; title: string; hint: React.ReactNode; name?: string }) {
	return (
		<FrameCard label={name} aside={status}>
			<div className="flex items-center gap-3 px-3 py-3">
				<Laptop className="size-5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span className="block font-medium">{title}</span>
					<span className="block truncate text-[13px] text-muted-foreground">{hint}</span>
				</span>
				<ChevronRight className="size-4 text-muted-foreground" />
			</div>
		</FrameCard>
	);
}

/**
 * Home: the empty state the Mac app and the website open on (the headline and the next step: add a repository), then
 * your projects and the swarm on your Mac.
 */
export function MobileHome({ user }: { user: SessionData["user"] }) {
	const projects = useProjects();
	const [adding, setAdding] = useState(false);
	const navigate = useNavigate();
	const none = projects?.length === 0;
	return (
		<div className="flex min-h-dvh flex-col bg-background">
			<TopBar
				left={<LogoMark size={26} />}
				title="Formal Mind"
				right={
					<>
						<BellLink />
						<button type="button" onClick={() => navigate("/settings")} aria-label="Settings" className="grid size-9 place-items-center overflow-hidden rounded-full border bg-muted text-[13px] font-medium">
							{user.picture ? <img src={user.picture} alt="" className="size-full object-cover" /> : (user.name ?? user.nickname ?? "?").slice(0, 1).toUpperCase()}
						</button>
					</>
				}
			/>
			<main className="fm-home fm-under-tabs flex flex-1 flex-col">
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
						<FrameCard label="Projects" aside={String(projects.length)}>
							<ul className="divide-y">
								{recentProjects(projects).map((p) => (
									<li key={p.repo}>
										<Link to={projectPath(p.repo)} className="flex items-center gap-3 px-3 py-3 active:bg-muted">
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
						</FrameCard>
					) : null}
					<MacCard />
				</div>
			</main>
			<TabBar active="home" repo={lastProject()} />
		</div>
	);
}
