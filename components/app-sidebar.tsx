"use client"

import { useEffect, useState } from "react";
import { Link, useLocation } from "react-router";
import { BookOpen, ChevronRight, GanttChart, Network, Palette, Plus } from "lucide-react"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { NavUser } from "@/components/nav-user"
import { LogoMark } from "@/components/logo"
import { projectPath, useProjectChats, useProjects, type Project } from "@/components/projects/use-projects"

type NavItem = { title: string; url: string; icon: React.ElementType }

const FOOTER: NavItem[] = [
	{ title: "Get started", url: "/github", icon: BookOpen },
]

/* Plain text throughout, no bold: the current page gets a soft pill, everything else stays quiet. */
const ROW = "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm font-normal text-sidebar-foreground/90 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"
const ACTIVE = "bg-sidebar-accent text-sidebar-foreground"

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
	return (
		<SidebarMenuItem>
			<SidebarMenuButton asChild isActive={active} tooltip={item.title} className="font-normal data-[active=true]:font-normal">
				<Link to={item.url}>
					<item.icon />
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

/** One project as a folder: its name, a chevron, and a + for a new chat; inside, its chats. */
function ProjectFolder({ project, open, onOpenChange, pathname }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void; pathname: string }) {
	const chats = useProjectChats(project.repo)
	const name = project.repo.split("/")[1] ?? project.repo

	return (
		<Collapsible open={open} onOpenChange={onOpenChange} asChild>
			<li className="list-none">
				<div className="group/folder flex h-8 items-center rounded-md pr-1">
					<CollapsibleTrigger className="flex min-w-0 flex-1 items-center gap-1 px-2 text-left text-sm font-normal text-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring" title={project.repo}>
						<span className="truncate">{name}</span>
						<ChevronRight className={`size-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`} aria-hidden />
					</CollapsibleTrigger>
					<Link
						to={projectPath(project.repo, "chat")}
						aria-label={`New chat in ${project.repo}`}
						title="New chat"
						className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-70 hover:bg-sidebar-accent hover:text-sidebar-foreground hover:opacity-100 focus-visible:opacity-100"
					>
						<Plus className="size-3.5" />
					</Link>
				</div>
				<CollapsibleContent>
					<ul className="flex flex-col gap-0.5 pb-2">
						{chats.map((c) => {
							const url = projectPath(project.repo, `chat/${c.id}`)
							return (
								<li key={c.id}>
									<Link to={url} title={c.title} className={`${ROW} ${pathname === url ? ACTIVE : ""}`}>
										<span className="truncate">{c.title}</span>
									</Link>
								</li>
							)
						})}
					</ul>
				</CollapsibleContent>
			</li>
		</Collapsible>
	)
}

function Projects({ pathname }: { pathname: string }) {
	const projects = useProjects()
	const [open, setOpen] = useOpenFolders()
	// The folder holding the page you are on opens by itself.
	const here = projects?.find((p) => pathname.startsWith(projectPath(p.repo)))?.repo
	useEffect(() => {
		if (here && open[here] === undefined) setOpen(here, true)
	}, [here, open, setOpen])

	if (!projects) return null
	return (
		<ul className="mt-2 flex flex-col gap-0.5 group-data-[collapsible=icon]:hidden">
			{projects.map((p, i) => (
				<ProjectFolder
					key={p.repo}
					project={p}
					// Unseen folders: the one you are in, or else the first, starts open.
					open={open[p.repo] ?? (here ? here === p.repo : i === 0)}
					onOpenChange={(value) => setOpen(p.repo, value)}
					pathname={pathname}
				/>
			))}
		</ul>
	)
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
	const pathname = useLocation().pathname
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
						<NavLink item={{ title: "Swarm", url: "/", icon: Network }} active={pathname === "/" || pathname === "/swarm/chat"} />
						<NavLink item={{ title: "Roadmap", url: "/roadmap", icon: GanttChart }} active={pathname === "/roadmap" || pathname.endsWith("/roadmap")} />
						<SidebarMenuItem>
							<SidebarMenuButton asChild isActive={pathname === "/onboarding" && window.location.search.includes("new=1")} tooltip="New project" className="font-normal data-[active=true]:font-normal">
								<Link to="/onboarding?new=1">
									<Plus />
									<span>New project</span>
								</Link>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
					<Projects pathname={pathname} />
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					{FOOTER.map((item) => <NavLink key={item.url} item={item} active={pathname === item.url} />)}
					{/* The brand kit is a static page in public/brand, so a full page load, not a router link. */}
					<SidebarMenuItem>
						<SidebarMenuButton asChild tooltip="Brand kit" className="font-normal">
							<a href="/brand/">
								<Palette />
								<span>Brand kit</span>
							</a>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
				<NavUser />
			</SidebarFooter>
		</Sidebar>
	)
}
