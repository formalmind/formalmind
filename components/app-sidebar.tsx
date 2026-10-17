"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpen, GanttChart, KanbanSquare, MessageCircle, Network, PanelLeftClose, PanelLeftOpen, Rocket } from "lucide-react"
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
import { NavUser } from "@/components/nav-user"

type NavItem = { title: string; url: string; icon: React.ElementType }

const NAV: NavItem[] = [
	{ title: "Swarm", url: "/", icon: Network },
	{ title: "Chat", url: "/chat", icon: MessageCircle },
	{ title: "Kanban", url: "/kanban", icon: KanbanSquare },
	{ title: "Roadmap", url: "/roadmap", icon: GanttChart },
]

const FOOTER: NavItem[] = [
	{ title: "Set up a repo", url: "/onboarding", icon: Rocket },
	{ title: "Get started", url: "/github", icon: BookOpen },
]

function NavLink({ item, active }: { item: NavItem; active: boolean }) {
	return (
		<SidebarMenuItem>
			{active ? <span aria-hidden className="absolute -left-2 bottom-1.5 top-1.5 w-[3px] rounded-full bg-blue-600 dark:bg-blue-400" /> : null}
			<SidebarMenuButton asChild isActive={active} tooltip={item.title}>
				<Link href={item.url}>
					<item.icon />
					<span>{item.title}</span>
				</Link>
			</SidebarMenuButton>
		</SidebarMenuItem>
	)
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
	const pathname = usePathname()
	const { state, toggleSidebar } = useSidebar()
	const collapsed = state === "collapsed"
	// The landing page is a page of its own, even for someone signed in.
	if (pathname === "/welcome") return null

	return (
		<Sidebar variant="inset" collapsible="icon" {...props}>
			{/* The toggle sits at the top, the way macOS sidebars carry it. */}
			<SidebarHeader className="flex-row justify-end group-data-[collapsible=icon]:justify-center">
				<button
					type="button"
					onClick={toggleSidebar}
					aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
					className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground [&>svg]:size-4"
				>
					{collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
				</button>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{NAV.map((item) => <NavLink key={item.url} item={item} active={pathname === item.url} />)}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<SidebarMenu>
					{FOOTER.map((item) => <NavLink key={item.url} item={item} active={pathname === item.url} />)}
				</SidebarMenu>
				<NavUser />
			</SidebarFooter>
		</Sidebar>
	)
}
