"use client"

import { MarkGithubIcon } from "@primer/octicons-react"
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { Archive, ArchiveRestore, ChevronRight, GitBranch, Plus } from "lucide-react"
import { ProjectContextMenu } from "@/components/projects/swarm-control"
import { useArchived } from "@/components/folder-menu"
import { cachedTree, freshEnough, syncRepo, type RepoTree } from "@/lib/browser-git"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NavUser, ThemeSwitch } from "@/components/nav-user"
import { LocalHeading, TreeFolder } from "@/components/session-folder"
import { FileTree } from "@/components/file-tree"
import { DEMO_TREE } from "@/components/demo-tree"
import { loadDemoRepos, type DemoData } from "@/components/demo/load"
import { SidebarResizer } from "@/components/sidebar-resizer"
import { LogoMark } from "@/components/logo"
import { BUILD } from "@/lib/build-info"
import { projectPath, useProjects, type Project } from "@/components/projects/use-projects"

/** `anim` names the hover animation in globals.css (icon-anim-*). */
type NavItem = { title: string; url: string; icon: React.ElementType; anim?: string }

/** Links pinned above the account in the footer (none for now; the /github guide stays reachable by URL). */
const FOOTER: NavItem[] = []

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active} tooltip={item.title} className="font-normal data-[active=true]:font-normal">
				<Link to={item.url} className="icon-anim-host">
					<item.icon className={item.anim ? `icon-anim-${item.anim}` : undefined} />
					<span>{item.title}</span>
				</Link>
			</SidebarMenuButton>
		</SidebarMenuItem>
	)
}

/** Which project folders are open, remembered in this browser. */
function useOpenFolders() {
	const [open, setOpen] = useState<Record<string, boolean>>(() => {
		try {
			return JSON.parse(localStorage.getItem("fm-open-projects") ?? "{}")
		} catch {
			return {}
		}
	})
	const set = (repo: string, value: boolean) =>
		setOpen((prev) => {
			const next = { ...prev, [repo]: value }
			try {
				localStorage.setItem("fm-open-projects", JSON.stringify(next))
			} catch {
				// Storage refused: the folder state lasts for this visit.
			}
			return next
		})
	return [open, set] as const
}

/** One project as a folder: its icon, name, a chevron, and a + for a new chat; inside, its chats. */
/**
 * Where imported repositories are read from when not from the browser: the Mac app clones each one (or maps a folder
 * you already have) and reads it from disk. `local` resolves the folder; `tree` lists it; `open` shows it (or a file).
 */
export type RepoSource = { local: (repo: string) => Promise<string>; tree: (path: string) => Promise<RepoTree>; open: (path: string, file?: string) => void; current: () => { path: string | null; file: string | null } }

/** The server's listing (GitHub API): used only when the browser has no copy of the repository and git can't fetch one. */
async function apiTree(repo: string): Promise<RepoTree> {
	const r = await fetch(`/api/projects/tree?repo=${encodeURIComponent(repo)}`)
	const body = await r.json().catch(() => ({}))
	if (!r.ok) throw new Error(body.error ?? "Couldn't list the files.")
	return body as RepoTree
}

/**
 * A project's files on its default branch. The browser's own git copy shows straight away when there is one, then a
 * background fetch brings it up to date; a first visit clones it. The API listing is the fallback when git can't.
 */
function useRepoTree(repo: string, on: boolean, source?: RepoSource) {
	const [tree, setTree] = useState<RepoTree | null>(null)
	const [error, setError] = useState<string | null>(null)
	const [path, setPath] = useState<string | null>(null)
	useEffect(() => {
		if (!on) return
		let live = true
		if (source) {
			// On disk: clone (or find) it, then list it like any folder.
			void source.local(repo).then(
				async (p) => {
					if (!live) return
					setPath(p)
					const t = await source.tree(p)
					if (live) {
						setTree(t)
						setError(null)
					}
				},
				(e) => live && setError(String(e?.message ?? e)),
			)
			return () => {
				live = false
			}
		}
		void (async () => {
			const cached = await cachedTree(repo).catch(() => null)
			if (cached && live) setTree(cached)
			if (cached && freshEnough(repo)) return
			try {
				await syncRepo(repo)
				const fresh = await cachedTree(repo)
				if (fresh && live) {
					setTree(fresh)
					setError(null)
				}
			} catch (e) {
				console.warn("[git] couldn't sync", repo, e)
				if (cached) return
				await apiTree(repo).then(
					(t) => live && setTree(t),
					(e2) => live && setError(String(e2.message ?? e2)),
				)
			}
		})()
		return () => {
			live = false
		}
	}, [repo, on, source])
	return { tree, error, path }
}

function ProjectFolder({ project, open, onOpenChange, pathname, collapsed, onExpand, archived, onArchive, source }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void; pathname: string; collapsed: boolean; onExpand: () => void; archived: boolean; onArchive: (archived: boolean) => void; source?: RepoSource }) {
	const name = project.repo.split("/")[1] ?? project.repo
	const navigate = useNavigate()
	const home = projectPath(project.repo)
	// Selected (any page of the project), its files show underneath.
	const location = useLocation()
	// In the Mac app the repository opens as its folder on disk, so its files list whenever it is unfolded.
	// Any unfolded repository lists its files (from the browser's git copy, or from disk in the Mac app).
	const { tree, error, path } = useRepoTree(project.repo, open, source)
	const here = source?.current()
	const current = source ? Boolean(path && here?.path === path) : pathname === home || pathname.startsWith(`${home}/`)
	const q = new URLSearchParams(location.search)
	const file = source ? (current ? (here?.file ?? null) : null) : pathname === projectPath(project.repo, "code") ? q.get("file") : pathname === projectPath(project.repo, "file") ? q.get("path") : null

	return (
		<Collapsible open={open} onOpenChange={onOpenChange} asChild>
			<li className={`list-none ${archived ? "opacity-60" : ""}`}>
				<ProjectContextMenu repo={project.repo} swarm={Boolean(project.proofsRepo)} archived={archived} onArchive={onArchive}>
				{(dots) => (
				<div className="group/folder flex h-8 items-center rounded-md pr-1 hover:bg-sidebar-accent group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0">
					{/* Collapsed, only the folder shows: a click widens the sidebar with this project open. */}
					<CollapsibleTrigger
						onClick={(e) => {
							if (collapsed) {
								e.preventDefault()
								onExpand()
							} else if (source) {
								// The Mac app: open its folder on disk (Code, Swarm, Proofs, Bugs), cloning it the first time.
								if (!current) {
									e.preventDefault()
									onOpenChange(true)
									void source.local(project.repo).then((p) => source.open(p), () => {})
								}
							} else if (pathname !== home) {
								// From elsewhere, a click opens the project's map; on it, the click folds the folder.
								e.preventDefault()
								onOpenChange(true)
								navigate(home)
							}
						}}
						className={`flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm font-normal outline-none ${(source ? current : pathname === home) ? "font-medium text-sidebar-foreground" : "text-sidebar-foreground/90"} focus-visible:ring-2 focus-visible:ring-sidebar-ring`}
						title={project.repo}
					>
						{/* An imported repository, not a folder on disk: the GitHub mark is its icon (also on the collapsed rail). */}
						<MarkGithubIcon size={16} className="shrink-0 text-muted-foreground" aria-hidden />
						<span className="truncate group-data-[collapsible=icon]:hidden">{name}</span>
						<ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[collapsible=icon]:hidden ${open ? "rotate-90" : ""}`} aria-hidden />
					</CollapsibleTrigger>
					{dots}
					{/* An imported repository: the branch mark (always the right-most) says it comes from git, and opens it on GitHub. */}
					<a
						href={`https://github.com/${project.repo}`}
						target="_blank"
						rel="noreferrer"
						aria-label={`${project.repo} on GitHub`}
						title={`${project.repo} on GitHub`}
						className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-background hover:text-sidebar-foreground group-data-[collapsible=icon]:hidden"
					>
						<GitBranch className="size-3.5" />
					</a>
				</div>
				)}
				</ProjectContextMenu>
				<CollapsibleContent className="pl-3 group-data-[collapsible=icon]:hidden">
					{open ? (
						tree ? (
							<FileTree
								paths={tree.files}
								truncated={tree.truncated}
								selected={file}
								storageKey={`fm:tree:${project.repo}`}
								onOpen={(f) => (source && path ? source.open(path, f) : navigate(`${projectPath(project.repo, "code")}?mode=code&file=${encodeURIComponent(f)}`))}
							/>
						) : (
							<p className="px-2 py-1 text-[12px] text-muted-foreground">{error ?? (source && !path ? "Cloning…" : "Listing the files…")}</p>
						)
					) : null}
				</CollapsibleContent>
			</li>
		</Collapsible>
	)
}

function Projects({ pathname, source }: { pathname: string; source?: RepoSource }) {
	const projects = useProjects()
	const [open, setOpen] = useOpenFolders()
	const { archived, setArchived } = useArchived()
	const [showArchived, setShowArchived] = useState(false)
	const sidebar = useSidebar()
	const collapsed = sidebar.state === "collapsed" && !sidebar.isMobile
	// The folder holding the page you are on opens by itself.
	const here = projects?.find((p) => pathname.startsWith(projectPath(p.repo)))?.repo
	useEffect(() => {
		if (here && open[here] === undefined) setOpen(here, true)
	}, [here, open, setOpen])

	if (!projects) return null
	const shown = projects.filter((p) => showArchived || !archived.includes(p.repo))
	const hidden = projects.filter((p) => archived.includes(p.repo)).length
	return (
		<ul className="mt-2 flex flex-col gap-0.5">
			{shown.map((p, i) => (
				<ProjectFolder
					key={p.repo}
					project={p}
					// Unseen folders: the one you are in, or else the first, starts open.
					open={open[p.repo] ?? (here ? here === p.repo : i === 0)}
					onOpenChange={(value) => setOpen(p.repo, value)}
					pathname={pathname}
					collapsed={collapsed}
					onExpand={() => {
						setOpen(p.repo, true)
						sidebar.setOpen(true)
					}}
					archived={archived.includes(p.repo)}
					onArchive={(on) => setArchived(p.repo, on)}
					source={source}
				/>
			))}
			{/* Archived projects leave the list; this brings them back into view (right-click one to unarchive). */}
			{hidden ? (
				<li className="list-none group-data-[collapsible=icon]:hidden">
					<button type="button" onClick={() => setShowArchived((v) => !v)} className="px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground">
						{showArchived ? "Hide archived" : `Archived · ${hidden}`}
					</button>
				</li>
			) : null}
		</ul>
	)
}

/** `extra` is for a host's own sections under the projects (the desktop app's local folders). */
export function AppSidebar({ extra, repoSource, ...props }: React.ComponentProps<typeof Sidebar> & { extra?: React.ReactNode; repoSource?: RepoSource }) {
	const location = useLocation()
	const navigate = useNavigate()
	const pathname = location.pathname
	const inApp = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
	// On localhost, the demo folder: a real repository's files when its data has been built.
	const [demos, setDemos] = useState<DemoData[]>([])
	const [addHelp, setAddHelp] = useState(false)
	const { archived, setArchived } = useArchived()
	const [showArchivedDemos, setShowArchivedDemos] = useState(false)
	const archivedDemo = (d: DemoData | null) => archived.includes(`demo:${d?.name ?? "sample"}`)
	const hiddenDemos = (demos.length ? demos : [null]).filter(archivedDemo).length
	useEffect(() => {
		if (typeof window !== "undefined" && window.location.hostname === "localhost") void loadDemoRepos().then(setDemos)
	}, [])
	// The landing page is a page of its own, even for someone signed in.
	if (pathname === "/welcome") return null

	return (
		<Sidebar variant="inset" collapsible="icon" {...props}>
			{/* The toggle sits at the top, the way macOS sidebars carry it. */}
			{/* Collapsed, the logo stays as the icon of the wordmark. It keeps one inset in both states so it holds
			    still while the wordmark fades off its right. The toggle is on each page, just outside the sidebar. */}
			<SidebarHeader className="flex-row items-center group-data-[collapsible=icon]:flex-col group-data-[collapsible=icon]:gap-1">
				<Link to="/" aria-label="Formal Mind" className="flex h-8 items-center gap-2 px-1.5 text-sm font-semibold tracking-tight group-data-[collapsible=icon]:gap-0">
					<LogoMark size={20} className="shrink-0" />
					{/* Fades out with the transitions.dev text-swap timing as the rail narrows. */}
					<span className="max-w-40 overflow-hidden whitespace-nowrap font-display text-[21px] font-normal leading-none tracking-normal transition-[max-width,opacity,filter] [transition-duration:var(--text-swap-dur)] [transition-timing-function:var(--text-swap-ease)] group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:blur-[var(--text-swap-blur)] motion-reduce:transition-none">
						Formal Mind.
					</span>
				</Link>
				{/* The sidebar's own toggle, in the same place on every page (the Mac app keeps it in its tab bar). */}
				{inApp ? null : <SidebarTrigger className="ml-auto size-7 text-muted-foreground hover:text-foreground group-data-[collapsible=icon]:ml-0" />}
			</SidebarHeader>
			<SidebarContent>
				{extra}
				{/* On localhost, the desktop app's local-folder page with demo data, for design feedback. */}
				{!extra && typeof window !== "undefined" && window.location.hostname === "localhost" ? (
					<SidebarGroup>
						<LocalHeading onAdd={() => setAddHelp((v) => !v)} />
						{/* The browser can't read folders on disk: the Mac app's + adds any folder; here the demo data does. */}
						{addHelp ? (
							<div className="mx-2 mb-2 space-y-1.5 rounded-lg border bg-background p-2.5 text-[12px] leading-5 text-muted-foreground">
								<p>The web preview shows repos built into its demo data. To add one, run:</p>
								<code className="block select-all break-all rounded bg-muted px-1.5 py-1 font-mono text-[11px] text-foreground">bun scripts/demo-data.ts --add ~/path/to/repo</code>
								<p>then reload. In the Mac app, + adds any folder directly.</p>
							</div>
						) : null}
						<ul className="flex flex-col gap-0.5">
							{(demos.length ? demos : [null]).filter((d) => showArchivedDemos || !archivedDemo(d)).map((demo) => {
								const params = new URLSearchParams(location.search)
								const isCurrent = pathname === "/local-demo" && (demo ? (params.get("repo") ?? demos[0]?.name) === demo.name : true)
								const repoParam = demo && demos.indexOf(demo) > 0 ? `?repo=${encodeURIComponent(demo.name)}` : ""
								return (
									<TreeFolder
										key={demo?.path ?? "sample"}
										name={demo?.name ?? "lending-protocol"}
										title={demo?.path}
										href={`/local-demo${repoParam}`}
										current={isCurrent}
										dim={archivedDemo(demo)}
										menu={[{ label: archivedDemo(demo) ? "Unarchive" : "Archive", icon: archivedDemo(demo) ? ArchiveRestore : Archive, onSelect: () => setArchived(`demo:${demo?.name ?? "sample"}`, !archivedDemo(demo)) }]}
									>
										<FileTree
											paths={demo?.files ?? DEMO_TREE}
											selected={isCurrent ? params.get("file") : null}
											storageKey={`fm:tree:demo:${demo?.name ?? "sample"}`}
											onOpen={(f) => {
												const next = isCurrent ? new URLSearchParams(location.search) : new URLSearchParams()
												if (demo) next.set("repo", demo.name)
												next.set("file", f)
												next.set("mode", "code")
												next.delete("line")
												navigate(`/local-demo?${next.toString()}`)
											}}
										/>
									</TreeFolder>
								)
							})}
							{hiddenDemos ? (
								<li className="list-none group-data-[collapsible=icon]:hidden">
									<button type="button" onClick={() => setShowArchivedDemos((v) => !v)} className="px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground">
										{showArchivedDemos ? "Hide archived" : `Archived · ${hiddenDemos}`}
									</button>
								</li>
							) : null}
						</ul>
					</SidebarGroup>
				) : null}
				<SidebarGroup>
					<SidebarMenu>
						{/* Imported repositories, under the local folders: a quiet heading, and + to import one. */}
						<li className="mt-2 flex h-7 items-center justify-between pl-2 pr-1 text-xs font-medium text-sidebar-foreground/60 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
							<span className="group-data-[collapsible=icon]:hidden">Import</span>
							<Link
								to="/onboarding?new=1"
								aria-label="Import a repository"
								title="Import a repository"
								className="icon-anim-host flex size-6 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
							>
								<Plus className="icon-anim-plus size-4" />
							</Link>
						</li>
					</SidebarMenu>
					<Projects pathname={pathname} source={repoSource} />
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					{FOOTER.map((item) => <NavLink key={item.url} item={item} active={pathname === item.url} />)}
				</SidebarMenu>
				<NavUser />
				<div className="flex items-center justify-between gap-2 px-2 group-data-[collapsible=icon]:hidden">
					<p className="text-[11px] text-muted-foreground/70 tabular-nums" title="Version and commit">{BUILD}</p>
					<ThemeSwitch />
				</div>
			</SidebarFooter>
			<SidebarResizer />
		</Sidebar>
	)
}
