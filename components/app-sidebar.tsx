"use client"

import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { BookOpen, Folder, FolderOpen, ChevronRight, GanttChart, MessagesSquare, Plus } from "lucide-react"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { SwarmMenu } from "@/components/projects/swarm-control"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NavUser } from "@/components/nav-user"
import { LocalHeading, TreeFolder } from "@/components/session-folder"
import { FileTree } from "@/components/file-tree"
import { DEMO_TREE } from "@/components/demo-tree"
import { loadDemoData, type DemoData } from "@/components/demo/load"
import { SidebarResizer } from "@/components/sidebar-resizer"
import { LogoMark } from "@/components/logo"
import { BUILD } from "@/lib/build-info"
import { projectPath, useProjectChats, useProjects, useWorkingChats, type Project } from "@/components/projects/use-projects"

/** `anim` names the hover animation in globals.css (icon-anim-*). */
type NavItem = { title: string; url: string; icon: React.ElementType; anim?: string }

const FOOTER: NavItem[] = [
	{ title: "Get started", url: "/github", icon: BookOpen, anim: "book" },
]

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
type RepoTree = { files: string[]; truncated: boolean }
const trees = new Map<string, Promise<RepoTree>>()

/** A project's files on its default branch, fetched once per session. */
function useRepoTree(repo: string, on: boolean) {
	const [tree, setTree] = useState<RepoTree | null>(null)
	const [error, setError] = useState<string | null>(null)
	useEffect(() => {
		if (!on) return
		if (!trees.has(repo)) {
			trees.set(
				repo,
				fetch(`/api/projects/tree?repo=${encodeURIComponent(repo)}`).then(async (r) => {
					const body = await r.json().catch(() => ({}))
					if (!r.ok) throw new Error(body.error ?? "Couldn't list the files.")
					return body as RepoTree
				}),
			)
		}
		let live = true
		trees.get(repo)!.then(
			(t) => live && setTree(t),
			(e) => {
				trees.delete(repo)
				if (live) setError(String(e.message ?? e))
			},
		)
		return () => {
			live = false
		}
	}, [repo, on])
	return { tree, error }
}

/** The project's chats, from the row: they live by the chat, not in the sidebar. */
function ChatsMenu({ repo }: { repo: string }) {
	const chats = useProjectChats(repo)
	const working = useWorkingChats()
	const navigate = useNavigate()
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				aria-label={`Chats in ${repo}`}
				title="Chats"
				className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 outline-none hover:bg-background hover:text-sidebar-foreground group-hover/folder:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100 group-data-[collapsible=icon]:hidden"
			>
				<MessagesSquare className="size-3.5" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="w-64">
				<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Chats</DropdownMenuLabel>
				{chats.length === 0 ? <DropdownMenuItem disabled className="text-[13px]">No chats yet</DropdownMenuItem> : null}
				{chats.slice(0, 20).map((c) => (
					<DropdownMenuItem key={c.id} onSelect={() => navigate(projectPath(repo, `chat/${c.id}`))} className="text-[13px]">
						<span className="min-w-0 flex-1 truncate">{c.title}</span>
						{working.has(`${repo}:${c.id}`) ? <span className="size-2 shrink-0 rounded-full bg-blue-500 motion-safe:animate-pulse" aria-label="Agent working" /> : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	)
}

function ProjectFolder({ project, open, onOpenChange, pathname, collapsed, onExpand }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void; pathname: string; collapsed: boolean; onExpand: () => void }) {
	const name = project.repo.split("/")[1] ?? project.repo
	const navigate = useNavigate()
	const home = projectPath(project.repo)
	// Selected (any page of the project), its files show underneath.
	const current = pathname === home || pathname.startsWith(`${home}/`)
	const { tree, error } = useRepoTree(project.repo, current && open)
	const location = useLocation()
	const file = pathname === projectPath(project.repo, "file") ? new URLSearchParams(location.search).get("path") : null

	return (
		<Collapsible open={open} onOpenChange={onOpenChange} asChild>
			<li className="list-none">
				<div className="group/folder flex h-8 items-center rounded-md pr-1 hover:bg-sidebar-accent group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:p-0">
					{/* Collapsed, only the folder shows: a click widens the sidebar with this project open. */}
					<CollapsibleTrigger
						onClick={(e) => {
							if (collapsed) {
								e.preventDefault()
								onExpand()
							} else if (pathname !== home) {
								// From elsewhere, a click opens the project's map; on it, the click folds the folder.
								e.preventDefault()
								onOpenChange(true)
								navigate(home)
							}
						}}
						className={`flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left text-sm font-normal outline-none ${pathname === home ? "font-medium text-sidebar-foreground" : "text-sidebar-foreground/90"} focus-visible:ring-2 focus-visible:ring-sidebar-ring`}
						title={project.repo}
					>
						{/* Closed and open folders cross-fade; hovering lifts the lid a little. */}
						<span className="fm-folder relative size-4 shrink-0" data-open={open && !collapsed ? "" : undefined} aria-hidden>
							<Folder className="fm-folder-closed absolute inset-0 size-4" />
							<FolderOpen className="fm-folder-open absolute inset-0 size-4" />
						</span>
						<span className="truncate group-data-[collapsible=icon]:hidden">{name}</span>
						<ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[collapsible=icon]:hidden ${open ? "rotate-90" : ""}`} aria-hidden />
					</CollapsibleTrigger>
					<Link
						to={projectPath(project.repo, "chat")}
						aria-label={`New chat in ${project.repo}`}
						title="New chat"
						className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 hover:bg-background hover:text-sidebar-foreground group-hover/folder:opacity-100 focus-visible:opacity-100 group-data-[collapsible=icon]:hidden"
					>
						<Plus className="size-3.5" />
					</Link>
					<ChatsMenu repo={project.repo} />
					{project.proofsRepo ? <SwarmMenu repo={project.repo} /> : null}
				</div>
				<CollapsibleContent className="pl-3 group-data-[collapsible=icon]:hidden">
					{current ? (
						tree ? (
							<FileTree
								paths={tree.files}
								truncated={tree.truncated}
								selected={file}
								storageKey={`fm:tree:${project.repo}`}
								onOpen={(f) => navigate(`${projectPath(project.repo, "file")}?path=${encodeURIComponent(f)}`)}
							/>
						) : (
							<p className="px-2 py-1 text-[12px] text-muted-foreground">{error ?? "Listing the files…"}</p>
						)
					) : null}
				</CollapsibleContent>
			</li>
		</Collapsible>
	)
}

function Projects({ pathname }: { pathname: string }) {
	const projects = useProjects()
	const [open, setOpen] = useOpenFolders()
	const sidebar = useSidebar()
	const collapsed = sidebar.state === "collapsed" && !sidebar.isMobile
	// The folder holding the page you are on opens by itself.
	const here = projects?.find((p) => pathname.startsWith(projectPath(p.repo)))?.repo
	useEffect(() => {
		if (here && open[here] === undefined) setOpen(here, true)
	}, [here, open, setOpen])

	if (!projects) return null
	return (
		<ul className="mt-2 flex flex-col gap-0.5">
			{projects.map((p, i) => (
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
				/>
			))}
		</ul>
	)
}

/** `extra` is for a host's own sections under the projects (the desktop app's local folders). */
export function AppSidebar({ extra, ...props }: React.ComponentProps<typeof Sidebar> & { extra?: React.ReactNode }) {
	const location = useLocation()
	const navigate = useNavigate()
	const pathname = location.pathname
	// On localhost, the demo folder: a real repository's files when its data has been built.
	const [demo, setDemo] = useState<DemoData | null>(null)
	useEffect(() => {
		if (typeof window !== "undefined" && window.location.hostname === "localhost") void loadDemoData().then(setDemo)
	}, [])
	// The landing page is a page of its own, even for someone signed in.
	if (pathname === "/welcome") return null

	return (
		<Sidebar variant="inset" collapsible="icon" {...props}>
			{/* The toggle sits at the top, the way macOS sidebars carry it. */}
			{/* Collapsed, the logo stays as the icon of the wordmark. It keeps one inset in both states so it holds
			    still while the wordmark fades off its right. The toggle is on each page, just outside the sidebar. */}
			<SidebarHeader className="flex-row items-center">
				<Link to="/" aria-label="Formal Mind" className="flex h-8 items-center gap-2 px-1.5 text-sm font-semibold tracking-tight group-data-[collapsible=icon]:gap-0">
					<LogoMark size={20} className="shrink-0" />
					{/* Fades out with the transitions.dev text-swap timing as the rail narrows. */}
					<span className="max-w-40 overflow-hidden whitespace-nowrap transition-[max-width,opacity,filter] [transition-duration:var(--text-swap-dur)] [transition-timing-function:var(--text-swap-ease)] group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:blur-[var(--text-swap-blur)] motion-reduce:transition-none">
						Formal Mind.
					</span>
				</Link>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{/* One swarm, one budget, working across every project: the home page. */}
						<NavLink item={{ title: "Roadmap", url: "/roadmap", icon: GanttChart, anim: "roadmap" }} active={pathname === "/roadmap" || pathname.endsWith("/roadmap")} />
						{/* Your projects below the app's pages: a gap, a quiet heading, and + to add one (like a section header). */}
						<li className="mt-4 flex h-7 items-center justify-between pl-2 pr-1 text-xs font-medium text-sidebar-foreground/60 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0">
							<span className="group-data-[collapsible=icon]:hidden">Projects</span>
							<Link
								to="/onboarding?new=1"
								aria-label="New project"
								title="New project"
								className="icon-anim-host flex size-6 items-center justify-center rounded-md text-sidebar-foreground/60 outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
							>
								<Plus className="icon-anim-plus size-4" />
							</Link>
						</li>
					</SidebarMenu>
					<Projects pathname={pathname} />
				</SidebarGroup>
				{extra}
				{/* On localhost, the desktop app's local-folder page with demo data, for design feedback. */}
				{!extra && typeof window !== "undefined" && window.location.hostname === "localhost" ? (
					<SidebarGroup>
						<LocalHeading />
						<ul className="flex flex-col gap-0.5">
							<TreeFolder name={demo?.name ?? "lending-protocol"} title={demo?.path} href="/local-demo" current={pathname === "/local-demo"}>
								<FileTree
									paths={demo?.files ?? DEMO_TREE}
									selected={new URLSearchParams(location.search).get("file")}
									storageKey="fm:tree:demo"
									onOpen={(f) => {
										const next = new URLSearchParams(location.search)
										next.set("file", f)
										next.set("mode", "code")
										navigate(`/local-demo?${next.toString()}`)
									}}
								/>
							</TreeFolder>
						</ul>
					</SidebarGroup>
				) : null}
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					{FOOTER.map((item) => <NavLink key={item.url} item={item} active={pathname === item.url} />)}
				</SidebarMenu>
				<NavUser />
				<p className="px-2 text-[11px] text-muted-foreground/70 tabular-nums group-data-[collapsible=icon]:hidden" title="Version and commit">{BUILD}</p>
			</SidebarFooter>
			<SidebarResizer />
		</Sidebar>
	)
}
