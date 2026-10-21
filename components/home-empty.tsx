import type { ReactNode } from "react";
import { Bug, Code2, ScanSearch, type LucideIcon } from "lucide-react";

/** The app's three parts, drawn with their tab icons where the headline names them. */
const PART_ICONS: Record<string, LucideIcon> = { bugs: Bug, proofs: ScanSearch, code: Code2 };

/** "Bugs, proofs and code." with each part's icon before its word. */
function withIcons(line: string) {
	return line.split(/(\w+)/).map((piece, i) => {
		const Icon = PART_ICONS[piece.toLowerCase()];
		return Icon ? (
			<span key={i} className="whitespace-nowrap">
				<Icon className="mr-[0.14em] inline-block size-[0.8em] align-[-0.08em]" strokeWidth={1.75} aria-hidden />
				{piece}
			</span>
		) : (
			piece
		);
	});
}

/**
 * The home page: an empty screen with the one next step (open or add a folder, or pick a project), instead of the
 * swarm canvas, which lives at /swarm. The headline is the onboarding's: a muted line over a strong one, in the
 * display face.
 */
export function HomeEmpty({ muted, strong, hint, children }: { muted: string; strong: string; hint?: ReactNode; children?: ReactNode }) {
	return (
		<div className="flex min-h-0 flex-1 items-center justify-center p-6">
			<div className="flex w-full max-w-lg flex-col items-center text-center">
				<h1 className="fm-rise font-display text-5xl leading-[1.05] [animation-delay:80ms]">
					<span className="text-muted-foreground/70">{withIcons(muted)}</span>
					<br />
					{strong}
				</h1>
				{hint ? <p className="fm-rise mt-5 text-sm leading-6 text-muted-foreground [animation-delay:160ms]">{hint}</p> : null}
				{children ? <div className="fm-rise mt-8 w-full max-w-sm [animation-delay:220ms]">{children}</div> : null}
			</div>
		</div>
	);
}
