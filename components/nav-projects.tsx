"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronRight, FolderGit2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useChatConversations, type RepoProject } from "@/components/chat-conversations";
import {
	SidebarGroup,
	SidebarGroupLabel,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarMenuSub,
	SidebarMenuSubButton,
	SidebarMenuSubItem,
} from "@/components/ui/sidebar";

export function NavProjects() {
	const [projects, setProjects] = useState<RepoProject[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [isDevPreview, setIsDevPreview] = useState(false);
	const { conversations, activeConversation, createConversation, selectConversation, isReady } = useChatConversations();
	const pathname = usePathname();
	const router = useRouter();

	useEffect(() => {
		let isCurrent = true;
		fetch("/api/github/repos")
			.then(async (response) => {
				if (!response.ok) throw new Error("Unable to load repositories");
				return response.json() as Promise<{ repos?: RepoProject[]; devPreview?: boolean }>;
			})
			.then((data) => {
				if (isCurrent) {
					setProjects(data.repos ?? []);
					setIsDevPreview(Boolean(data.devPreview));
				}
			})
			.catch((error) => console.error("Failed to load GitHub projects:", error))
			.finally(() => {
				if (isCurrent) setIsLoading(false);
			});
		return () => { isCurrent = false; };
	}, []);

	const createProjectChat = (project: RepoProject) => {
		createConversation(project);
		router.push(`/github/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}`);
	};

	const selectProjectChat = (conversationId: string, project: RepoProject) => {
		selectConversation(conversationId);
		router.push(`/github/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}`);
	};

	return (
		<SidebarGroup>
			<SidebarGroupLabel>Projects</SidebarGroupLabel>
			<SidebarMenu>
				{isLoading && (
					<SidebarMenuItem>
						<SidebarMenuButton disabled><span>Loading repositories…</span></SidebarMenuButton>
					</SidebarMenuItem>
				)}
				{!isLoading && projects.length === 0 && (
					<SidebarMenuItem>
						{isDevPreview ? (
							<SidebarMenuButton disabled><span>Configure GitHub to see projects</span></SidebarMenuButton>
						) : (
							<SidebarMenuButton asChild>
								<a href="/auth/login?connection=github&access_type=offline&prompt=consent">
									<span>Connect GitHub to see projects</span>
								</a>
							</SidebarMenuButton>
						)}
					</SidebarMenuItem>
					)}
				{projects.map((project) => {
					const projectChats = conversations
						.filter((conversation) => conversation.repo?.fullName === project.fullName)
						.sort((a, b) => b.updatedAt - a.updatedAt);
					const route = `/github/${encodeURIComponent(project.owner)}/${encodeURIComponent(project.name)}`;
					const active = activeConversation?.repo?.fullName === project.fullName;
					return (
						<Collapsible key={project.id} asChild defaultOpen={active || pathname === route}>
							<SidebarMenuItem>
								<CollapsibleTrigger asChild>
									<SidebarMenuButton isActive={active || pathname === route} tooltip={project.fullName}>
										<FolderGit2 />
										<span>{project.fullName}</span>
										<ChevronRight className="ml-auto transition-transform data-[state=open]:rotate-90" />
									</SidebarMenuButton>
								</CollapsibleTrigger>
								<CollapsibleContent>
									<SidebarMenuSub>
										<SidebarMenuSubItem>
											<SidebarMenuSubButton asChild>
												<button type="button" onClick={() => createProjectChat(project)}>
													<span>+ New chat</span>
												</button>
											</SidebarMenuSubButton>
										</SidebarMenuSubItem>
										{isReady && projectChats.slice(0, 8).map((conversation) => (
											<SidebarMenuSubItem key={conversation.id}>
												<SidebarMenuSubButton
													isActive={activeConversation?.id === conversation.id}
													onClick={() => selectProjectChat(conversation.id, project)}
													title={conversation.title}
												>
													<span>{conversation.title}</span>
												</SidebarMenuSubButton>
											</SidebarMenuSubItem>
										))}
									</SidebarMenuSub>
								</CollapsibleContent>
							</SidebarMenuItem>
						</Collapsible>
					);
				})}
			</SidebarMenu>
		</SidebarGroup>
	);
}
