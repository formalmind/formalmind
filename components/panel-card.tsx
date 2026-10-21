/** A small mono, uppercase label: the title on a panel card. */
export const PanelLabel = ({ children }: { children: React.ReactNode }) => (
	<p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{children}</p>
);

/** The app's card: a gray container carrying the title, and the content on a white card inside it (Usage, Billing). */
export function PanelCard({ label, action, children, className = "", bodyClassName = "p-4" }: { label: string; action?: React.ReactNode; children: React.ReactNode; className?: string; bodyClassName?: string }) {
	return (
		<section className={`flex flex-col rounded-2xl border bg-muted/60 p-1.5 ${className}`}>
			<header className="flex h-9 shrink-0 items-center justify-between gap-2 pl-2.5 pr-1">
				<PanelLabel>{label}</PanelLabel>
				{action}
			</header>
			<div className={`shadow-card flex min-h-0 flex-1 flex-col rounded-xl border bg-card ${bodyClassName}`}>{children}</div>
		</section>
	);
}
