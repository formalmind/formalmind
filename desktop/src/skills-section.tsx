import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Skill = { id: string; name: string; author: string; licence: string; about: string; source: string; added: boolean };

/** Settings → Skills: free auditing checklists by other authors, added once for every project (docs/skills.md). */
export function Skills() {
	const [skills, setSkills] = useState<Skill[]>([]);
	const [busy, setBusy] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const load = () => void invoke<Skill[]>("skills_catalog").then(setSkills, (e) => setError(String(e)));
	useEffect(load, []);
	const toggle = (s: Skill) => {
		setBusy(s.id);
		setError(null);
		void invoke(s.added ? "skills_remove" : "skills_add", { id: s.id })
			.then(load, (e) => setError(String(e)))
			.finally(() => setBusy(null));
	};
	return (
		<div className="space-y-2">
			<ul className="divide-y rounded-xl border bg-card">
				{skills.map((s) => (
					<li key={s.id} className="flex items-center gap-3 px-3 py-2.5">
						<div className="min-w-0 flex-1">
							<p className="text-foreground">
								{s.name} <span className="text-muted-foreground">· {s.author}</span>
							</p>
							<p className="truncate text-muted-foreground">
								{s.about} ·{" "}
								<a href={s.source} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-foreground">
									{s.licence}
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
