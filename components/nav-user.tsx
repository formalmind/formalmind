"use client"

import { Link } from "react-router";
import { forgetLandingProgress } from "@/components/landing/use-plan";
import {
	ChevronsUpDown,
	CreditCard,
	Gauge,
	LogIn,
	LogOut,
	Monitor,
	Moon,
	Sun,
} from "lucide-react"
import { useTheme } from "next-themes"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	useSidebar,
} from "@/components/ui/sidebar"

import { useAuth } from "@/components/auth-context"
import { inDesktop, openOnWeb } from "@/lib/open-web"

export function NavUser() {
	const { isMobile } = useSidebar()
	const { user } = useAuth()

	if (!user) {
		return (
			<SidebarMenu>
				<SidebarMenuItem>
					<SidebarMenuButton size="lg" variant="outline" asChild>
						<a href="/auth/login" className="flex items-center gap-2">
							<LogIn className="size-5" />
							<span className="font-medium">Log in to your account</span>
						</a>
					</SidebarMenuButton>
				</SidebarMenuItem>
			</SidebarMenu>
		)
	}

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<SidebarMenuButton
							size="lg"
							className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
						>
							<Avatar className="h-8 w-8 rounded-lg">
								<AvatarImage src={user.picture} alt={user.name} />
								<AvatarFallback className="rounded-lg">
									{user.name?.charAt(0).toUpperCase()}
								</AvatarFallback>
							</Avatar>
							<div className="grid flex-1 text-left text-sm leading-tight">
								<span className="truncate font-display text-[17px] font-normal leading-tight">{user.name}</span>
								<span className="truncate text-xs text-muted-foreground">{user.email}</span>
							</div>
							<ChevronsUpDown className="ml-auto size-4" />
						</SidebarMenuButton>
					</DropdownMenuTrigger>
					<DropdownMenuContent
						className="w-[--radix-dropdown-menu-trigger-width] min-w-52 rounded-lg [&_[role=menuitem]]:py-1 [&_[role=menuitem]]:text-[13px] [&_[role=menuitem]]:text-muted-foreground [&_[role=menuitem]:focus]:text-foreground/80 [&_[role=menuitem]_svg]:size-3.5 [&_[role=separator]]:my-0.5"
						side={isMobile ? "bottom" : "right"}
						align="end"
						sideOffset={4}
					>
						<DropdownMenuLabel className="p-0 font-normal">
							<div className="flex items-center gap-2 px-1 py-1 text-left text-sm">
								<Avatar className="h-7 w-7 rounded-lg">
									<AvatarImage src={user.picture} alt={user.name} />
									<AvatarFallback className="rounded-lg">
										{user.name?.charAt(0).toUpperCase()}
									</AvatarFallback>
								</Avatar>
								<div className="grid flex-1 text-left text-sm leading-tight">
									<span className="truncate font-display text-[15px] font-normal leading-tight">{user.name}</span>
									<span className="truncate text-xs text-muted-foreground">{user.email}</span>
								</div>
							</div>
						</DropdownMenuLabel>
						<DropdownMenuSeparator />
						<DropdownMenuGroup>
							<DropdownMenuItem asChild>
								<Link to="/usage">
									<Gauge />
									Usage
								</Link>
							</DropdownMenuItem>
							{/* The Mac app has no billing page of its own: it opens formal.team's. */}
							{inDesktop() ? (
								<DropdownMenuItem onSelect={() => openOnWeb("/billing")}>
									<CreditCard />
									Billing
								</DropdownMenuItem>
							) : (
								<DropdownMenuItem asChild>
									<Link to="/billing">
										<CreditCard />
										Billing
									</Link>
								</DropdownMenuItem>
							)}
						</DropdownMenuGroup>
						<DropdownMenuSeparator />
						<DropdownMenuItem asChild>
							{/* Logging out also resets the landing page to its demo. */}
							<a href="/auth/logout" onClick={forgetLandingProgress} className="flex items-center gap-2">
								<LogOut />
								Log out
							</a>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</SidebarMenuItem>
		</SidebarMenu>
	)
}

/** Light, dark, or whatever the system uses: three small buttons, shown beside the version in the sidebar footer. */
export function ThemeSwitch() {
	const { theme, setTheme } = useTheme()
	const options = [
		{ key: "light", label: "Light", icon: Sun },
		{ key: "dark", label: "Dark", icon: Moon },
		{ key: "system", label: "System", icon: Monitor },
	] as const
	return (
			<div role="radiogroup" aria-label="Theme" className="flex rounded-full bg-muted p-0.5">
				{options.map(({ key, label, icon: Icon }) => (
					<button
						key={key}
						type="button"
						role="radio"
						aria-checked={(theme ?? "system") === key}
						aria-label={label}
						title={label}
						onClick={() => setTheme(key)}
						className={`flex size-5 items-center justify-center rounded-full transition-colors ${(theme ?? "system") === key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}
					>
						<Icon className="size-3" />
					</button>
				))}
			</div>
	)
}
