"use client";

import { usePathname } from "next/navigation";
import { SidebarInset, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@radix-ui/react-separator";
import BreadCrumbs from "@/components/bread-crumbs";

export function WorkspaceContent({ children }: { children: React.ReactNode }) {
	const pathname = usePathname();
	const isChat = pathname === "/" || pathname === "/chat";
	return (
		<div className={isChat ? "flex h-dvh min-w-0 flex-1 overflow-hidden bg-background" : "flex-1 overflow-x-auto bg-background"}>
			<SidebarInset className={isChat ? "min-h-0 min-w-0 flex-1 bg-background" : "flex-1 w-full overflow-x-auto"}>
				<header className={isChat ? "hidden" : "flex h-16 shrink-0 items-center gap-2"}>
					<div className="flex items-center gap-2 px-4">
						<SidebarTrigger className="-ml-1" />
						<Separator orientation="vertical" className="mr-2 h-4" />
						<BreadCrumbs />
					</div>
				</header>
				{isChat ? (
					<div className="flex min-h-0 flex-1 flex-col">{children}</div>
				) : (
					<div className="flex flex-1 flex-col min-h-0 gap-4 p-4 pt-0 text-sm">
						<article className="px-1 markdown prose max-w-full dark:prose-invert">{children}</article>
					</div>
				)}
			</SidebarInset>
		</div>
	);
}
