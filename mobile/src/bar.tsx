import { useNavigate } from "react-router";
import { ChevronLeft } from "lucide-react";

/** The screen's top bar, under the status bar: back (or the app's mark), the title, and actions on the right. */
export function TopBar({ title, sub, back, left, right }: { title: React.ReactNode; sub?: React.ReactNode; back?: string | true; left?: React.ReactNode; right?: React.ReactNode }) {
	const navigate = useNavigate();
	return (
		<header className="fm-safe-top sticky top-0 z-30 border-b bg-background/85 backdrop-blur-xl">
			<div className="flex h-12 items-center gap-1 px-2">
				{back ? (
					<button type="button" onClick={() => (back === true ? navigate(-1) : navigate(back))} aria-label="Back" className="grid size-10 place-items-center rounded-full text-foreground active:bg-muted">
						<ChevronLeft className="size-6" />
					</button>
				) : (
					<span className="grid size-10 place-items-center">{left}</span>
				)}
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-[15px] font-semibold leading-5">{title}</h1>
					{sub ? <p className="truncate text-[12px] leading-4 text-muted-foreground">{sub}</p> : null}
				</div>
				<div className="flex items-center gap-1 pr-1">{right}</div>
			</div>
		</header>
	);
}

/** One icon in a floating capsule (FloatingBar's `right`). */
export function GlassSegment({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
	return (
		<button type="button" onClick={onClick} aria-label={label} className="relative grid h-[50px] w-11 place-items-center text-foreground active:opacity-60">
			{children}
		</button>
	);
}

export const GlassDivider = () => <span className="h-6 w-px bg-border" aria-hidden />;

/**
 * Controls floating over a full-screen page, as Mike's chat has them: a round glass back button on the left, a glass
 * capsule of icon buttons on the right; the page scrolls on underneath.
 */
export function FloatingBar({ back, title, right, left, onLeft, leftLabel }: { back: string | true; title?: React.ReactNode; right?: React.ReactNode; left?: React.ReactNode; onLeft?: () => void; leftLabel?: string }) {
	const navigate = useNavigate();
	return (
		<div className="fm-safe-top fm-floating-fade pointer-events-none fixed inset-x-0 top-0 z-30">
			<div className="relative flex items-start gap-3 px-4 pt-1.5">
				<button type="button" onClick={() => (onLeft ? onLeft() : back === true ? navigate(-1) : navigate(back))} aria-label={leftLabel ?? "Back"} className="fm-glass pointer-events-auto grid size-[50px] shrink-0 place-items-center rounded-full text-foreground">
					{left ?? <ChevronLeft className="size-6" />}
				</button>
				<div className="min-w-0 flex-1 pt-3.5 text-center">{title ? <span className="fm-glass pointer-events-auto inline-block max-w-full truncate rounded-full px-3 py-1 text-[13px] font-medium">{title}</span> : null}</div>
				{right ? <div className="fm-glass pointer-events-auto flex shrink-0 items-center rounded-full px-1">{right}</div> : <span className="size-[50px]" />}
			</div>
		</div>
	);
}

/** A screen with nothing to show yet, as the onboarding draws it: a tile, a muted line over a strong one, a hint. */
export function CenterState({ icon, muted, strong, body, children }: { icon: React.ReactNode; muted: string; strong: string; body?: React.ReactNode; children?: React.ReactNode }) {
	return (
		<div className="flex flex-1 flex-col items-center justify-center px-8 py-10 text-center">
			<span className="fm-rise grid size-16 place-items-center rounded-2xl border bg-card text-muted-foreground shadow-card">{icon}</span>
			<h2 className="fm-rise mt-7 font-display text-[34px] leading-[1.08] [animation-delay:60ms]">
				<span className="text-muted-foreground/70">{muted}</span>
				<br />
				{strong}
			</h2>
			{body ? <p className="fm-rise mt-4 max-w-xs text-[15px] leading-6 text-muted-foreground [animation-delay:120ms]">{body}</p> : null}
			{children ? <div className="fm-rise mt-6 [animation-delay:160ms]">{children}</div> : null}
		</div>
	);
}

/** A placeholder in the shape of what's coming, instead of a spinner or "Loading…". */
export function Skeleton({ className = "" }: { className?: string }) {
	return <span aria-hidden className={`fm-skeleton block rounded-lg ${className}`} />;
}

/** Rows of a list while it loads (Code's folders and files). */
export function ListSkeleton({ rows = 8 }: { rows?: number }) {
	return (
		<ul aria-label="Loading" className="divide-y">
			{Array.from({ length: rows }, (_, i) => (
				<li key={i} className="flex items-center gap-3 px-4 py-3.5">
					<Skeleton className="size-4 shrink-0" />
					<Skeleton className={`h-3.5 ${["w-1/3", "w-1/2", "w-2/5", "w-3/5", "w-1/4"][i % 5]}`} />
				</li>
			))}
		</ul>
	);
}

/** Lines of code while a file loads. */
export function CodeSkeleton({ lines = 14 }: { lines?: number }) {
	const widths = ["w-1/3", "w-3/4", "w-1/2", "w-5/6", "w-2/3", "w-1/4", "w-3/5"];
	return (
		<div aria-label="Loading" className="space-y-2.5 p-4">
			{Array.from({ length: lines }, (_, i) => (
				<Skeleton key={i} className={`h-3 ${widths[i % widths.length]}`} />
			))}
		</div>
	);
}

/** A summary card and shelves of cards while Proofs or Bugs builds. */
export function ShelvesSkeleton() {
	return (
		<div aria-label="Loading" className="space-y-6">
			<div className="mx-4 rounded-2xl border bg-muted/60 p-1.5">
				<Skeleton className="m-2.5 h-3 w-24" />
				<div className="rounded-xl border bg-card p-4">
					<Skeleton className="h-10 w-24" />
					<Skeleton className="mt-4 h-2 w-full" />
					<Skeleton className="mt-4 h-6 w-2/3" />
				</div>
			</div>
			{[0, 1].map((s) => (
				<div key={s} className="space-y-2">
					<Skeleton className="mx-4 h-5 w-40" />
					<div className="flex gap-3 overflow-hidden px-4">
						{[0, 1].map((c) => (
							<div key={c} className="h-[168px] w-[78%] max-w-[300px] shrink-0 rounded-2xl border bg-card p-3.5">
								<Skeleton className="h-3 w-16" />
								<Skeleton className="mt-3 h-4 w-3/4" />
								<Skeleton className="mt-2 h-4 w-1/2" />
								<Skeleton className="mt-6 h-12 w-full" />
							</div>
						))}
					</div>
				</div>
			))}
		</div>
	);
}
