import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Skill = { id: string; name: string; author: string; licence: string; about: string; source: string; roles: string[]; files: number; added: boolean };

/**
 * One folder's skills (Settings → Skills): free auditing checklists from other authors, added to that folder's swarm.
 * Add copies them into .formal/skills/ from a pinned commit; the agents whose role they fit read them (docs/skills.md).
 */
export function FolderSkills({ folder, label }: { folder: string; label?: string }) {
	const [skills, setSkills] = useState<Skill[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = () => void invoke<Skill[]>("skills_catalog", { folder }).then(setSkills, (e) => setError(String(e)));
	useEffect(load, [folder]);
	const toggle = (s: Skill) => {
		setBusy(s.id);
		setError(null);
		void invoke(s.added ? "skills_remove" : "skills_add", { folder, id: s.id })
			.then(load, (e) => setError(String(e)))
			.finally(() => setBusy(null));
	};
	return (
		<div className="space-y-2">
			<p className="text-muted-foreground" title={folder}>
				{label ?? folder.split("/").pop()}
			</p>
			<ul className="divide-y rounded-xl border bg-card">
				{skills.map((s) => (
					<li key={s.id} className="flex items-start gap-3 px-3 py-2.5">
						<div className="min-w-0 flex-1 space-y-0.5">
							<p className="text-foreground">
								{s.name} <span className="text-muted-foreground">· {s.author}</span>
							</p>
							<p className="text-muted-foreground">{s.about}</p>
							<p className="text-muted-foreground">
								{s.licence} · {s.files} {s.files === 1 ? "file" : "files"} · read by the {s.roles.join(", ")} ·{" "}
								<a href={s.source} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
									source
								</a>
							</p>
						</div>
						<button
							type="button"
							onClick={() => toggle(s)}
							disabled={busy !== null}
							className={`h-7 shrink-0 rounded-full px-3 disabled:opacity-50 ${s.added ? "border text-muted-foreground hover:text-foreground" : "btn-dark"}`}
						>
							{busy === s.id ? (s.added ? "Removing…" : "Adding…") : s.added ? "Remove" : "Add"}
						</button>
					</li>
				))}
			</ul>
			{error ? <p className="text-red-600">{error}</p> : null}
		</div>
	);
}
