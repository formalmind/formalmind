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
export function FloatingBar({ back, title, right }: { back: string | true; title?: React.ReactNode; right?: React.ReactNode }) {
	const navigate = useNavigate();
	return (
		<div className="fm-safe-top fm-floating-fade pointer-events-none fixed inset-x-0 top-0 z-30">
			<div className="relative flex items-start gap-3 px-4 pt-1.5">
				<button type="button" onClick={() => (back === true ? navigate(-1) : navigate(back))} aria-label="Back" className="fm-glass pointer-events-auto grid size-[50px] shrink-0 place-items-center rounded-full text-foreground">
					<ChevronLeft className="size-6" />
				</button>
				<div className="min-w-0 flex-1 pt-3.5 text-center">{title ? <span className="fm-glass pointer-events-auto inline-block max-w-full truncate rounded-full px-3 py-1 text-[13px] font-medium">{title}</span> : null}</div>
				{right ? <div className="fm-glass pointer-events-auto flex shrink-0 items-center rounded-full px-1">{right}</div> : <span className="size-[50px]" />}
			</div>
		</div>
	);
}
