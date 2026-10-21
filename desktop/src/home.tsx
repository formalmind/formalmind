import { useNavigate } from "react-router";
import { Folder, FolderPlus } from "lucide-react";
import { HomeEmpty } from "@/components/home-empty";
import { useFolders } from "./local";

/** The Mac app's home: add a folder, or reopen one already added. */
export function DesktopHome() {
	const { folders, add } = useFolders();
	const navigate = useNavigate();
	const open = (path: string) => navigate(`/local?path=${encodeURIComponent(path)}`);
	return (
		<HomeEmpty muted={folders.length ? "Welcome back." : "Bugs, proofs and code."} strong={folders.length ? "Pick up where you left off." : "Open a repository to start."}>
			<div className="space-y-2">
				<button
					type="button"
					onClick={() => void add().then((p) => p && open(p))}
					className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-3 text-[15px] font-medium text-background transition hover:opacity-90"
				>
					<FolderPlus className="size-4" />
					Add a folder
				</button>
				{folders.length ? (
					<ul className="mt-4 space-y-1 text-left">
						{folders.map((f) => (
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
