import { useEffect, useState } from "react";
import { Check, ChevronLeft, Copy, FileCode2, FileText } from "lucide-react";
import { ChatMarkdown } from "@/components/chat-markdown";
import { ShelvesSkeleton } from "./bar";
import { useReportDirs } from "@/lib/report-dirs";
import { findingSection, SEVERITY, STATUS, useAuditFindings, type AuditFinding, type Bridge } from "@/desktop/src/swarm-panel";

const SEVERITIES = ["critical", "high", "medium", "low", "informational", "info", "gas"];
const sevKey = (s: string) => s.toLowerCase().trim();
const reportName = (r: string) => r.split("/").pop()?.replace(/\.(md|markdown|txt|pdf|audit\.json)$/i, "").replace(/[_-]+/g, " ") ?? r;
const clean = (t: string) => t.replace(/`/g, "");

function Shelf({ label, aside, children }: { label: string; aside?: React.ReactNode; children: React.ReactNode }) {
	return (
		<section className="space-y-2">
			<header className="flex items-baseline gap-2 px-4">
				<h2 className="min-w-0 truncate text-[20px] font-semibold capitalize tracking-tight">{label}</h2>
				{aside ? <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{aside}</span> : null}
			</header>
			<div className="flex snap-x snap-mandatory gap-3 overflow-x-auto scroll-px-4 px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">{children}</div>
		</section>
	);
}

function Chip({ className, children }: { className: string; children: React.ReactNode }) {
	return <span className={`inline-flex h-6 items-center rounded-full border px-2 text-[11px] font-medium capitalize ${className}`}>{children}</span>;
}

/** A finding as a card: its id and severity, the title, where it stands. */
function FindingCard({ f, onOpen }: { f: AuditFinding; onOpen: () => void }) {
	return (
		<button type="button" onClick={onOpen} className="flex h-[168px] w-[78%] max-w-[300px] shrink-0 snap-start flex-col rounded-2xl border bg-card p-3.5 text-left shadow-card active:scale-[0.98] active:bg-muted/40">
			<span className="flex items-center gap-2">
				<span className={`font-mono text-[13px] font-semibold ${STATUS[f.status].text}`}>{f.id}</span>
				{f.severity ? <Chip className={SEVERITY[sevKey(f.severity)] ?? "border-border bg-muted text-muted-foreground"}>{f.severity}</Chip> : null}
			</span>
			<span className="mt-2 line-clamp-3 text-[15px] font-medium leading-snug">{clean(f.title)}</span>
			<span className={`mt-auto text-[12px] font-medium ${STATUS[f.status].text}`}>{STATUS[f.status].label}</span>
		</button>
	);
}

/** One finding in full: where it stands and why, its proof of concept, and the report's own section; copy it. */
function FindingDetail({ f, folder, reports, invoke, onBack, onOpenFile }: { f: AuditFinding; folder: string; reports: string[]; invoke: Bridge["invoke"]; onBack: () => void; onOpenFile: (path: string) => void }) {
	const [section, setSection] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const reportPath = reports.find((r) => r.split("/").pop() === f.report) ?? null;
	useEffect(() => {
		if (!reportPath || /\.pdf$/i.test(reportPath)) return;
		void invoke<string>("folder_read", { folder, path: reportPath }).then((t) => setSection(findingSection(t, f.id, f.title)), () => setSection(null));
	}, [folder, reportPath, f.id, f.title, invoke]);
	const d = f.detail;
	const body = section ?? [d?.description, d?.impact && `**Impact.** ${d.impact}`, d?.recommendation && `**Recommendation.** ${d.recommendation}`].filter(Boolean).join("\n\n");
	const text = [`${f.id} · ${f.title}`, `${f.severity} · ${STATUS[f.status].label}`, f.evidence, body].filter(Boolean).join("\n\n");
	const frame = "rounded-2xl border bg-muted/60 p-1.5";
	const label = "flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground";
	return (
		<div className="fixed inset-0 z-40 overflow-y-auto bg-background">
			<header className="fm-safe-top sticky top-0 z-10 border-b bg-background/85 backdrop-blur-xl">
				<div className="flex h-12 items-center gap-1 px-2">
					<button type="button" onClick={onBack} aria-label="Back" className="grid size-10 place-items-center rounded-full active:bg-muted">
						<ChevronLeft className="size-6" />
					</button>
					<div className="min-w-0 flex-1">
						<h1 className={`font-mono text-[15px] font-semibold ${STATUS[f.status].text}`}>{f.id}</h1>
						<p className="truncate text-[12px] text-muted-foreground">{reportName(f.report)}</p>
					</div>
					<button
						type="button"
						onClick={() =>
							void navigator.clipboard.writeText(text).then(() => {
								setCopied(true);
								setTimeout(() => setCopied(false), 1500);
							})
						}
						className="inline-flex h-9 items-center gap-1.5 rounded-full px-3 text-[14px] font-medium active:bg-muted"
					>
						{copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
						{copied ? "Copied" : "Copy"}
					</button>
				</div>
			</header>
			<main className="fm-safe-bottom space-y-4 px-4 py-4">
				<h2 className="text-[22px] font-semibold leading-snug">{clean(f.title)}</h2>
				<div className="flex flex-wrap gap-2">
					<Chip className={STATUS[f.status].chip}>{STATUS[f.status].label}</Chip>
					{f.severity ? <Chip className={SEVERITY[sevKey(f.severity)] ?? "border-border bg-muted text-muted-foreground"}>{f.severity}</Chip> : null}
				</div>
				{f.evidence || f.statusText ? (
					<section className={frame}>
						<p className={label}>Status evidence</p>
						<div className="shadow-card rounded-xl border bg-card p-3 text-[14px] leading-relaxed">
							<ChatMarkdown>{f.evidence || f.statusText}</ChatMarkdown>
						</div>
					</section>
				) : null}
				{f.tests.length ? (
					<section className={frame}>
						<p className={label}>Proof of concept · {f.tests.length}</p>
						<ul className="shadow-card divide-y overflow-hidden rounded-xl border bg-card">
							{f.tests.map((t) => (
								<li key={t}>
									<button type="button" onClick={() => onOpenFile(t.split(":")[0])} className="flex w-full items-center gap-2 px-3 py-3 text-left font-mono text-[12px] active:bg-muted">
										<FileCode2 className="size-4 shrink-0 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate">{t}</span>
									</button>
								</li>
							))}
						</ul>
					</section>
				) : null}
				{body ? (
					<section className={frame}>
						<p className={label}>From the report</p>
						<div className="shadow-card rounded-xl border bg-card p-3 text-[14px] leading-relaxed">
							<ChatMarkdown>{body}</ChatMarkdown>
						</div>
					</section>
				) : null}
			</main>
		</div>
	);
}

/**
 * Bugs on the phone, as stacks to scroll: a summary, then each report's findings as a shelf of cards (Formal Mind's
 * first), and the reports themselves; a card opens the finding in full. The findings are Bugs' own
 * (useAuditFindings), read from the browser's git copy.
 */
export function BugsExplorer({ repo, files, invoke, onOpenFile }: { repo: string; files: string[] | null; invoke: Bridge["invoke"]; onOpenFile: (path: string) => void }) {
	const dirs = useReportDirs(repo);
	const { reports, findings } = useAuditFindings(repo, files ?? [], invoke, dirs);
	const [open, setOpen] = useState<AuditFinding | null>(null);
	const [only, setOnly] = useState<AuditFinding["status"] | null>(null);
	const shown = only ? findings.filter((f) => f.status === only) : findings;
	const counts = findings.reduce<Record<string, number>>((m, f) => ({ ...m, [f.status]: (m[f.status] ?? 0) + 1 }), {});
	const sev = findings.reduce<Record<string, number>>((m, f) => ({ ...m, [sevKey(f.severity || "unrated")]: (m[sevKey(f.severity || "unrated")] ?? 0) + 1 }), {});
	const groups = [...new Set(shown.map((f) => f.report))]
		.sort((a, b) => Number(/formal-mind/i.test(b)) - Number(/formal-mind/i.test(a)))
		.map((r) => ({ report: r, items: shown.filter((f) => f.report === r) }));
	return (
		<div className="fm-under-tabs min-h-0 flex-1 space-y-6 overflow-y-auto pb-4 pt-3">
			<section className="mx-4 rounded-2xl border bg-muted/60 p-1.5">
				<p className="flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
					Bugs
					<span className="ml-auto normal-case tracking-normal">
						{reports.length} report{reports.length === 1 ? "" : "s"}
					</span>
				</p>
				<div className="shadow-card rounded-xl border bg-card p-4">
					<div className="flex items-end justify-between">
						<span className="font-display text-[44px] leading-none">{findings.length}</span>
						<span className="pb-1 text-[13px] text-muted-foreground">findings</span>
					</div>
					<div className="mt-3 flex flex-wrap gap-1.5">
						{SEVERITIES.filter((s) => sev[s]).map((s) => (
							<Chip key={s} className={SEVERITY[s] ?? "border-border bg-muted text-muted-foreground"}>
								{sev[s]} {s}
							</Chip>
						))}
					</div>
				</div>
			</section>
			{/* Where they stand, as chips that filter the stacks. */}
			<div className="flex gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
				{(Object.keys(STATUS) as AuditFinding["status"][])
					.filter((k) => counts[k])
					.map((k) => (
						<button key={k} type="button" onClick={() => setOnly(only === k ? null : k)} className={`h-9 shrink-0 rounded-full border px-3.5 text-[13px] font-medium ${only === k ? "border-foreground bg-foreground text-background" : STATUS[k].chip}`}>
							{counts[k]} {STATUS[k].label.toLowerCase()}
						</button>
					))}
			</div>
			{!files ? <ShelvesSkeleton /> : null}
			{files && !findings.length && !reports.length ? <p className="px-4 text-[15px] text-muted-foreground">No audit reports or findings in this repository yet. The swarm files them here, each with a proof of concept.</p> : null}
			{groups.map((g) => (
				<Shelf key={g.report} label={reportName(g.report)} aside={g.items.length}>
					{g.items.map((f) => (
						<FindingCard key={`${f.report}#${f.id}#${f.title}`} f={f} onOpen={() => setOpen(f)} />
					))}
				</Shelf>
			))}
			{reports.length ? (
				<Shelf label="Reports" aside={reports.length}>
					{reports.map((r) => (
						<button key={r} type="button" onClick={() => onOpenFile(r)} className="flex h-[120px] w-[60%] max-w-[240px] shrink-0 snap-start flex-col rounded-2xl border bg-card p-3.5 text-left shadow-card active:bg-muted/40">
							<FileText className="size-5 text-muted-foreground" />
							<span className="mt-2 line-clamp-2 text-[15px] font-medium capitalize">{reportName(r)}</span>
							<span className="mt-auto truncate font-mono text-[11px] text-muted-foreground">{r}</span>
						</button>
					))}
				</Shelf>
			) : null}
			{open ? <FindingDetail f={open} folder={repo} reports={reports} invoke={invoke} onBack={() => setOpen(null)} onOpenFile={(p) => (setOpen(null), onOpenFile(p))} /> : null}
		</div>
	);
}
