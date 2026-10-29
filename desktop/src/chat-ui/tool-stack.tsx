import { BookCheck, Bug, FilePen, FileText, FolderSearch, Gavel, ListTree, NotebookPen, Search, SquareTerminal, Sparkle } from "lucide-react";

const ICONS: Record<string, typeof Search> = {
	run: SquareTerminal,
	read_file: FileText,
	write_file: FilePen,
	search: Search,
	find: FolderSearch,
	functions: ListTree,
	function: ListTree,
	record_finding: NotebookPen,
	record_property: BookCheck,
	record_report: NotebookPen,
	report_bug: Bug,
	verdict: Gavel,
};
export function ToolIcon({ tool }: { tool: string }) {
	const Icon = ICONS[tool] ?? Sparkle;
	return <Icon className="size-3 shrink-0" />;
}

const SHOWN = 3;

/** The tools an agent used as an overlapping stack of small round chips: at most three, then "+N". */
export function ToolStack({ tools }: { tools: string[] }) {
	if (!tools.length) return null;
	const rest = tools.length - SHOWN;
	return (
		<span className="inline-flex shrink-0 items-center" title={tools.join(", ")}>
			{tools.slice(0, SHOWN).map((t, i) => (
				<span key={t} className={`grid size-5 place-items-center rounded-full bg-muted text-muted-foreground ring-2 ring-card ${i ? "-ml-1.5" : ""}`} style={{ zIndex: SHOWN - i }}>
					<ToolIcon tool={t} />
				</span>
			))}
			{rest > 0 ? <span className="pl-1 tabular-nums text-muted-foreground">+{rest}</span> : null}
		</span>
	);
}
