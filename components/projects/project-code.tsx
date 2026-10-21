import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { SettingsMenu } from "@/components/projects/swarm-control";
import { NotificationCenter } from "@/components/notification-center";
import { projectPath, repoOf } from "@/components/projects/use-projects";
import { cachedTree, syncRepo } from "@/lib/browser-git";
import { SwarmPanel } from "@/desktop/src/swarm-panel";
import { makeGitBridge } from "./git-bridge";

type Scan = { solidity: string[]; lean: string[]; truncated: boolean; git?: boolean };

/**
 * An imported repository on the website, with the same tabs as a folder in the Mac app: Code and Bugs read the
 * browser's git copy, Proofs points to the Mac app, and Swarm goes to the project's swarm canvas.
 */
export function ProjectCodePage() {
	const { owner, name } = useParams();
	const repo = repoOf(owner, name) ?? "";
	const [params] = useSearchParams();
	const navigate = useNavigate();
	const bridge = useMemo(() => makeGitBridge(repo), [repo]);
	const [scan, setScan] = useState<Scan | null>(null);
	useEffect(() => {
		let live = true;
		setScan(null);
		void (async () => {
			const tree = (await cachedTree(repo).catch(() => null)) ?? (await syncRepo(repo).then(() => cachedTree(repo)).catch(() => null));
			if (live && tree) setScan({ solidity: tree.files.filter((f) => f.endsWith(".sol")), lean: tree.files.filter((f) => f.endsWith(".lean")), truncated: tree.truncated, git: true });
		})();
		return () => {
			live = false;
		};
	}, [repo]);
	useEffect(() => {
		if (repo) document.title = `${repo.split("/")[1]} · Formal Mind`;
	}, [repo]);
	return (
		<SwarmPanel
			key={repo}
			folder={repo}
			name={repo.split("/")[1] ?? repo}
			scan={scan}
			bridge={bridge}
			file={params.get("file")}
			defaultMode="code"
			onSwarm={() => navigate(projectPath(repo))}
			actions={
				<>
					<SettingsMenu repos={[]} className="inline-flex size-8 items-center justify-center rounded-full border bg-background/90 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground" />
					<NotificationCenter />
				</>
			}
		/>
	);
}
