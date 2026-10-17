"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";
import {
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
} from "@/components/ui/sidebar";

export function ThemeToggle() {
	const { resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	useEffect(() => setMounted(true), []);
	const isDark = mounted && resolvedTheme === "dark";

	return (
		<SidebarMenu>
			<SidebarMenuItem>
				<SidebarMenuButton
					type="button"
					aria-label={`Switch to ${isDark ? "light" : "dark"} mode`}
					title={`Switch to ${isDark ? "light" : "dark"} mode`}
					onClick={() => setTheme(isDark ? "light" : "dark")}
				>
					{isDark ? <Sun /> : <Moon />}
					<span>{isDark ? "Light mode" : "Dark mode"}</span>
				</SidebarMenuButton>
			</SidebarMenuItem>
		</SidebarMenu>
	);
}
