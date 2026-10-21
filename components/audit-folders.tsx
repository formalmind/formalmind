import { useState } from "react";
import { createPortal } from "react-dom";
import { Plus, X } from "lucide-react";
import { inDesktop } from "@/lib/open-web";
import { readReportDirs, saveReportDirs } from "@/lib/report-dirs";
import { readEntryPoints, saveEntryPoints } from "@/lib/entry-points";

/**
 * A path picked on this Mac, relative to the project: a native picker opened at the project (files filtered to `ext`, or
 * folders). Null when cancelled, on the web (there's no picker there), or when the pick is outside the project.
 */
async function pickInside(folder: string, kind: { ext: string } | "folder"): Promise<string | null> {
	if (!inDesktop()) return null;
	const { open } = await import("@tauri-apps/plugin-dialog");
	const picked = await open({ defaultPath: folder, directory: kind === "folder", filters: kind === "folder" ? undefined : [{ name: kind.ext, extensions: [kind.ext] }] });
	const path = typeof picked === "string" ? picked : null;
	const root = `${folder.replace(/\/+$/, "")}/`;
	return path?.startsWith(root) ? path.slice(root.length) : null;
}

/**
 * One project's list of paths: a chip per path with a remove button, and a button to add another. In the Mac app it
 * opens a picker at the project; on the web it is a field (Enter adds, Escape cancels).
 */
function PathList({ folder, label, values, onChange, pick, addLabel, placeholder }: { folder: string; label?: string; values: string[]; onChange: (next: string[]) => void; pick: { ext: string } | "folder"; addLabel: string; placeholder: string }) {
	const [adding, setAdding] = useState<string | null>(null);
	const [note, setNote] = useState<string | null>(null);
	const add = (path: string | null) => {
		if (path?.trim() && !values.includes(path.trim())) onChange([...values, path.trim()]);
		setAdding(null);
	};
	const start = async () => {
		setNote(null);
		if (!inDesktop()) return setAdding("");
		const path = await pickInside(folder, pick).catch(() => null);
		if (path === null) return setNote(`Pick one inside ${label ?? folder.split("/").pop()}.`);
		add(path);
	};
	return (
		<div className="flex items-start gap-3">
			<span className="flex h-7 w-40 shrink-0 items-center truncate font-medium" title={folder}>{label ?? folder.split("/").pop()}</span>
			<div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
				{values.map((d) => (
					<span key={d} className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-background pl-2 pr-1 font-mono text-[12px]">
						<span className="truncate">{d}</span>
						<button type="button" onClick={() => onChange(values.filter((x) => x !== d))} title={`Remove ${d}`} aria-label={`Remove ${d}`} className="grid size-5 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground">
							<X className="size-3" />
						</button>
					</span>
				))}
				{adding !== null ? (
					<input
						autoFocus
						value={adding}
						onChange={(e) => setAdding(e.target.value)}
						onBlur={() => add(adding)}
						onKeyDown={(e) => {
							if (e.key === "Enter") add(adding);
							if (e.key === "Escape") setAdding(null);
						}}
						placeholder={placeholder}
						className="h-7 w-48 rounded-md border bg-background px-2 font-mono text-[12px] outline-none focus:border-neutral-300 dark:focus:border-neutral-600"
					/>
				) : (
					<button type="button" onClick={() => void start()} className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-muted-foreground hover:bg-muted hover:text-foreground">
						<Plus className="size-3.5" /> {addLabel}
					</button>
				)}
				{note ? <span className="text-[11px] text-muted-foreground">{note}</span> : null}
			</div>
		</div>
	);
}

/** One project's audit report folders; removing the last one goes back to the defaults. */
export function AuditFolders({ folder, label }: { folder: string; label?: string }) {
	const [dirs, setDirs] = useState(() => readReportDirs(folder));
	return <PathList folder={folder} label={label} values={dirs} onChange={(next) => setDirs(saveReportDirs(folder, next.join(",")))} pick="folder" addLabel="Add folder" placeholder="docs/audits" />;
}

/** A small dialog for one project's audit folders, opened from its ⋯ menu in the sidebar. */
export function AuditFoldersDialog({ folder, label, onClose }: { folder: string; label: string; onClose: () => void }) {
	return createPortal(
		<div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
			<section role="dialog" aria-label={`Audit reports for ${label}`} className="w-full max-w-lg rounded-2xl border bg-muted p-1.5 shadow-pop">
				<header className="flex h-8 items-center gap-2 px-2.5">
					<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Audit reports</span>
					<button type="button" onClick={onClose} className="ml-auto rounded-md px-2 text-[12px] text-muted-foreground hover:bg-background hover:text-foreground">Done</button>
				</header>
				<div className="shadow-card space-y-3 rounded-xl border bg-card p-4 text-[13px]">
					<p className="text-[11px] text-muted-foreground">Where {label}'s audit reports are read from for Bugs, relative to its root.</p>
					<AuditFolders folder={folder} label={label.split("/").pop()} />
				</div>
			</section>
		</div>,
		document.body,
	);
}

/** One folder's entry points for Proofs: contracts, the first opening by default. */
export function EntryPoints({ folder, label }: { folder: string; label?: string }) {
	const [list, setList] = useState(() => readEntryPoints(folder));
	return <PathList folder={folder} label={label} values={list} onChange={(next) => setList(saveEntryPoints(folder, next))} pick={{ ext: "sol" }} addLabel="Select file" placeholder="src/Router.sol" />;
}
