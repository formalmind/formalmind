import { useNavigate } from "react-router";
import { Folder } from "lucide-react";
import { AddProjectCard } from "@/components/add-project";
import { HomeEmpty } from "@/components/home-empty";
import { recentFolders, useFolders } from "./local";

/** The Mac app's home: add a project (a folder here or a GitHub repository), or reopen one of the three folders opened
 * most recently (the sidebar lists them all). */
export function DesktopHome() {
	const { folders, add } = useFolders();
	const navigate = useNavigate();
	const open = (path: string) => navigate(`/local?path=${encodeURIComponent(path)}`);
	return (
		<HomeEmpty muted={folders.length ? "Welcome back." : "Bugs, proofs and code."} strong={folders.length ? "Pick up where you left off." : "Open a repository to start."}>
			<div className="space-y-2">
				<AddProjectCard onLocal={() => add().then((p) => p && open(p))} />
				{folders.length ? (
					<ul className="mt-4 space-y-1 text-left">
						{recentFolders(folders, 3).map((f) => (
							<li key={f}>
								<button type="button" onClick={() => open(f)} className="flex w-full items-center gap-2.5 rounded-lg border bg-card px-3 py-2 text-left hover:bg-muted">
									<Folder className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0">
										<span className="block truncate text-sm font-medium">{f.split(/[\\/]/).filter(Boolean).pop()}</span>
										<span className="block truncate font-mono text-[11px] text-muted-foreground">{f}</span>
									</span>
								</button>
							</li>
						))}
					</ul>
				) : null}
			</div>
		</HomeEmpty>
	);
}
