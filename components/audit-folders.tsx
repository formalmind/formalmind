import { useState } from "react";
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
