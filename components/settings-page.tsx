import { useEffect, useState } from "react";
import { AuditFolders, EntryPoints } from "@/components/audit-folders";
import { useProjects } from "@/components/projects/use-projects";
import { setVimMode, useVimMode } from "@/components/vim-mode";
import { loadDemoRepos, type DemoData } from "@/components/demo/load";

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
	<section className="rounded-2xl border bg-muted/60 p-1.5">
		<h2 className="flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
		<div className="shadow-card space-y-3 rounded-xl border bg-card p-4 text-[13px]">{children}</div>
	</section>
);

/** The website's settings: where each folder's audit reports live, and the editor. The Mac app has its own page. */
export function SettingsPage() {
	const vim = useVimMode();
	const projects = useProjects();
	const [demos, setDemos] = useState<DemoData[]>([]);
	useEffect(() => {
		if (window.location.hostname === "localhost") void loadDemoRepos().then(setDemos);
	}, []);
	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<main className="mx-auto w-full max-w-3xl space-y-3 px-6 pb-10 pt-2">
				<Section title="Audit folders">
					<p className="text-[11px] text-muted-foreground">Where each repository's audit reports are read from for Bugs, relative to its root. Separate several with commas.</p>
					{/* Imported repositories (their Bugs tab reads the browser's git copy), then the local demo's folders. */}
					{(projects ?? []).map((p) => (
						<AuditFolders key={p.repo} folder={p.repo} label={p.repo} />
					))}
					{demos.map((d) => (
						<AuditFolders key={d.path} folder={d.path} label={d.name} />
					))}
					{!projects?.length && !demos.length ? <p className="text-[11px] text-muted-foreground">Import a repository first.</p> : null}
				</Section>
				<Section title="Entry points">
					<p className="text-[11px] text-muted-foreground">The contracts Proofs models for each repository, comma-separated; the first opens by default.</p>
					{(projects ?? []).map((p) => (
						<EntryPoints key={p.repo} folder={p.repo} label={p.repo} />
					))}
					{demos.map((d) => (
						<EntryPoints key={d.path} folder={d.path} label={d.name} />
					))}
				</Section>
				<Section title="Editor">
					<label className="flex items-center justify-between gap-4">
						<span>
							<span className="font-medium">Vim mode</span>
							<span className="block text-[11px] text-muted-foreground">Vim keys in the code view.</span>
						</span>
						<input type="checkbox" checked={vim} onChange={(e) => setVimMode(e.target.checked)} className="size-4" />
					</label>
				</Section>
			</main>
		</div>
	);
}
