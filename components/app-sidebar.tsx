"use client"

import * as React from "react"
import {
	BookOpen,
	Bot,
	Frame,
	LifeBuoy,
	Send,
	Settings2,
	SquareTerminal,
} from "lucide-react"

import Image from "next/image"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarHeader,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar"
import { NavMain } from "@/components/nav-main"
import { NavProjects } from "@/components/nav-projects"
import { NavSecondary } from "@/components/nav-secondary"
import { NavUser } from "@/components/nav-user"
import Link from "next/link"

const data = {
	navMain: [
		{
			title: "Github",
			url: "/github",
			icon: SquareTerminal,
			isActive: true,
			items: [
				{
					title: "Playgorund",
					url: "/github/playground",
				},
				{
					title: "Webhooks",
					url: "/github/webhooks",
				},
				{
					title: "Settings",
					url: "/github/settings",
				},
			],
		},
		{
			title: "Agents",
			url: "",
			icon: Bot,
			isActive: true,
			items: [
				{
					title: "Modeling Agent",
					url: "/agents/modeling-agent",
				},
				{
					title: "Pr Reviewer Agent",
					url: "/agents/pr-reviewer-agent",
				},
				{
					title: "Push Reviewer Agent",
					url: "/agents/push-reviewer-agent",
				},
				{
					title: "Reconsiling Agent",
					url: "/agents/reconsiling-agent",
				},
				{
					title: "Testing Agent V1",
					url: "/agents/testing-agent-v1",
				},
				{
					title: "Testing Agent",
					url: "/agents/testing-agent",
				},
				{
					title: "Verification Agent",
					url: "/agents/verification-agent",
				},
			],
		},
		{
			title: "Documentation",
			url: "#",
			icon: BookOpen,
			isActive: true,
			items: [
				{
					title: "Introduction",
					url: "/documentation/introduction",
				},
				{
					title: "Get Started",
					url: "/documentation/get-started",
				},
				{
					title: "Tutorials",
					url: "/documentation/tutorials",
				},
				{
					title: "Agent Modes",
					url: "/documentation/agent-modes",
				},
				{
					title: "Changelog",
					url: "/documentation/changelog",
				},
			],
		},
		{
			title: "Settings",
			url: "#",
			icon: Settings2,
			items: [
				{
					title: "General",
					url: "#",
				},
				{
					title: "Team",
					url: "#",
				},
				{
					title: "Billing",
					url: "#",
				},
				{
					title: "Limits",
					url: "#",
				},
			],
		},
	],
	navSecondary: [
		{
			title: "Support",
			url: "#",
			icon: LifeBuoy,
		},
		{
			title: "Feedback",
			url: "#",
			icon: Send,
		},
	],
	projects: [
		{
			name: "Agent Design",
			url: "#",
			icon: Frame,
		},
	],
}

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
	return (
		<Sidebar variant="inset" {...props}>
			<SidebarHeader>
				<SidebarMenu>
					<SidebarMenuItem>
						<SidebarMenuButton size="lg" asChild>
							<Link href="/">
								<div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-sidebar-primary text-sidebar-primary-foreground">
									<Image
										className="block dark:hidden"
										alt="Formal Mind website logo"
										src="/SymbolDark.svg"
										width={24}
										height={24}
									/>
									<Image
										className="hidden dark:block"
										alt="Formal Mind website logo"
										src="/SymbolLight.svg"
										width={24}
										height={24}
									/>
								</div>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-semibold">Formal Mind AI</span>
									<span className="truncate text-xs">Enterprise</span>
								</div>
							</Link>
						</SidebarMenuButton>
					</SidebarMenuItem>
				</SidebarMenu>
			</SidebarHeader>
			<SidebarContent>
				<NavMain items={data.navMain} />
				<NavProjects projects={data.projects} />
				<NavSecondary items={data.navSecondary} className="mt-auto" />
			</SidebarContent>
			<SidebarFooter>
				<NavUser />
			</SidebarFooter>
		</Sidebar>
	)
}
