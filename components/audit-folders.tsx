import { useState } from "react";
import { createPortal } from "react-dom";
import { readReportDirs, saveReportDirs } from "@/lib/report-dirs";

/** One project's audit folders: saved on Enter or when the field loses focus. */
export function AuditFolders({ folder, label }: { folder: string; label?: string }) {
	const [text, setText] = useState(() => readReportDirs(folder).join(", "));
	const [saved, setSaved] = useState(false);
	const save = () => {
		setText(saveReportDirs(folder, text).join(", "));
		setSaved(true);
		setTimeout(() => setSaved(false), 1500);
	};
	return (
		<form
			className="flex items-center gap-3"
			onSubmit={(e) => {
				e.preventDefault();
				save();
			}}
		>
			<span className="w-40 shrink-0 truncate font-medium" title={folder}>{label ?? folder.split("/").pop()}</span>
			<input value={text} onChange={(e) => setText(e.target.value)} onBlur={save} placeholder="audit, audits, reports" className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 font-mono text-[12px] outline-none focus:border-neutral-300 dark:focus:border-neutral-600" />
			<span className={`w-10 text-xs text-emerald-600 transition-opacity ${saved ? "opacity-100" : "opacity-0"}`}>Saved</span>
		</form>
	);
}

/** A small dialog for one project's audit folders, opened from its ⋯ menu in the sidebar. */
export function AuditFoldersDialog({ folder, label, onClose }: { folder: string; label: string; onClose: () => void }) {
	return createPortal(
		<div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()} onKeyDown={(e) => e.key === "Escape" && onClose()}>
			<section role="dialog" aria-label={`Audit folders for ${label}`} className="w-full max-w-lg rounded-2xl border bg-muted p-1.5 shadow-pop">
				<header className="flex h-8 items-center gap-2 px-2.5">
					<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Audit folders</span>
					<button type="button" onClick={onClose} className="ml-auto rounded-md px-2 text-[12px] text-muted-foreground hover:bg-background hover:text-foreground">Done</button>
				</header>
				<div className="shadow-card space-y-3 rounded-xl border bg-card p-4 text-[13px]">
					<p className="text-[11px] text-muted-foreground">Where {label}'s audit reports are read from for Bugs, relative to its root. Separate several with commas.</p>
					<AuditFolders folder={folder} label={label.split("/").pop()} />
				</div>
			</section>
		</div>,
		document.body,
	);
}
