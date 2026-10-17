"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { BookOpen, MessageCircle, Network } from "lucide-react"
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar"
import { NavUser } from "@/components/nav-user"

const NAV = [
	{ title: "Swarm", url: "/", icon: Network },
	{ title: "Chat", url: "/chat", icon: MessageCircle },
	{ title: "Get started", url: "/github", icon: BookOpen },
]

export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
	const pathname = usePathname()
	return (
		<Sidebar variant="inset" {...props}>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						{NAV.map((item) => (
							<SidebarMenuItem key={item.url}>
								<SidebarMenuButton asChild isActive={pathname === item.url}>
									<Link href={item.url}>
										<item.icon />
										<span>{item.title}</span>
									</Link>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter>
				<NavUser />
			</SidebarFooter>
		</Sidebar>
	)
}
