import { Check, ChevronDown, FolderGit2 } from "lucide-react";
import { useNavigate } from "react-router";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { projectPath, useProjects } from "@/components/projects/use-projects";

/**
 * The project chip on a composer's shelf: which project the message is about. By default picking another opens
 * a chat there; `onSelect` keeps the choice in place instead (the agent chats).
 */
export function ProjectPicker({ repo, onSelect }: { repo: string; onSelect?: (repo: string) => void }) {
	const projects = useProjects() ?? [];
	const navigate = useNavigate();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger className="inline-flex h-8 items-center gap-1.5 rounded-full bg-secondary px-3 text-sm text-secondary-foreground outline-none hover:bg-secondary/80">
				<FolderGit2 className="size-3.5" />
				<span className="max-w-[14rem] truncate">{repo}</span>
				<ChevronDown className="size-3.5 text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" sideOffset={6}>
				{projects.map((p) => (
					<DropdownMenuItem key={p.repo} aria-current={p.repo === repo ? "true" : undefined} className={p.repo === repo ? "font-medium" : undefined} onSelect={() => p.repo !== repo && (onSelect ? onSelect(p.repo) : navigate(projectPath(p.repo, "chat")))}>
						<Check className={`size-4 ${p.repo === repo ? "" : "invisible"}`} />
						{p.repo}
					</DropdownMenuItem>
				))}
				<DropdownMenuItem onSelect={() => navigate("/onboarding?new=1")}>
					<span className="size-4" />
					New project…
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
