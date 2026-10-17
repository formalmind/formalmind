"use client"

import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
} from "@/components/ui/sidebar"
import { NavUser } from "@/components/nav-user"

/** Empty workspace rail while the chat-first home screen is being rebuilt. */
export function AppSidebar({ ...props }: React.ComponentProps<typeof Sidebar>) {
	return (
		<Sidebar variant="inset" {...props}>
			<SidebarContent />
			<SidebarFooter>
				<NavUser />
			</SidebarFooter>
		</Sidebar>
	)
}
