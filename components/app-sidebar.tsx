"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpen, GanttChart, MessageCircle, Network, Rocket } from "lucide-react"
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
import { NavUser } from "@/components/nav-user"
import { LogoMark } from "@/components/logo"

type NavItem = { title: string; url: string; icon: React.ElementType }

const NAV: NavItem[] = [
	{ title: "Swarm", url: "/", icon: Network },
	{ title: "Chat", url: "/chat", icon: MessageCircle },
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
	// The landing page is a page of its own, even for someone signed in.
	if (pathname === "/welcome") return null

	return (
		<Sidebar variant="inset" collapsible="icon" {...props}>
			{/* The toggle sits at the top, the way macOS sidebars carry it. */}
			{/* Collapsed, the logo stays as the icon of the wordmark. It keeps one inset in both states so it holds
			    still while the wordmark fades off its right. The toggle is on each page, just outside the sidebar. */}
			<SidebarHeader className="flex-row items-center">
				<Link href="/" aria-label="Formal Mind" className="flex h-8 items-center gap-2 px-1.5 text-sm font-semibold tracking-tight group-data-[collapsible=icon]:gap-0">
					<LogoMark size={20} className="shrink-0" />
					{/* Fades out with the transitions.dev text-swap timing as the rail narrows. */}
					<span className="max-w-40 overflow-hidden whitespace-nowrap transition-[max-width,opacity,filter] duration-[var(--text-swap-dur)] ease-[var(--text-swap-ease)] group-data-[collapsible=icon]:max-w-0 group-data-[collapsible=icon]:opacity-0 group-data-[collapsible=icon]:blur-[var(--text-swap-blur)] motion-reduce:transition-none">
						Formal Mind.
					</span>
				</Link>
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
