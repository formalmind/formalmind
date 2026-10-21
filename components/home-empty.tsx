import { useEffect, useState, type ReactNode } from "react";
import { Bug, Code2, ScanSearch, type LucideIcon } from "lucide-react";

/** The app's three parts, drawn with their tab icons where the headline names them. */
const PART_ICONS: Record<string, LucideIcon> = { bugs: Bug, proofs: ScanSearch, code: Code2 };

/** The muted line's parts, in the order it names them: those with an icon. */
const partsOf = (line: string) => (line.match(/\w+/g) ?? []).filter((w) => PART_ICONS[w.toLowerCase()]);

/**
 * A line naming the parts ("Bugs, proofs and code.") cycles through them, one at a time with its icon, each rising in
 * as the last goes; any other line is shown as it is. With reduced motion, the whole line stays, icons before the words.
 */
function Parts({ line }: { line: string }) {
	const parts = partsOf(line);
	const [i, setI] = useState(0);
	const [still] = useState(() => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
	useEffect(() => {
		if (parts.length < 2 || still) return;
		const t = setInterval(() => setI((n) => (n + 1) % parts.length), 2200);
		return () => clearInterval(t);
	}, [parts.length, still]);
	if (parts.length < 2) return <>{line}</>;
	const word = (w: string) => {
		const Icon = PART_ICONS[w.toLowerCase()];
		return (
			<>
				<Icon className="mr-[0.14em] inline-block size-[0.8em] align-[-0.08em]" strokeWidth={1.75} aria-hidden />
				{w}
			</>
		);
	};
	if (still) return <>{line.split(/(\w+)/).map((piece, k) => (PART_ICONS[piece.toLowerCase()] ? <span key={k}>{word(piece)}</span> : piece))}</>;
	const w = parts[i];
	return (
		<span key={i} className="fm-swap inline-block" aria-label={line}>
			{word(w[0].toUpperCase() + w.slice(1))}.
		</span>
	);
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
				<h1 className="fm-rise whitespace-nowrap font-display text-5xl leading-[1.05] [animation-delay:80ms]">
					<span className="whitespace-nowrap text-muted-foreground/70"><Parts line={muted} /></span>
					<br />
					{strong}
				</h1>
				{hint ? <p className="fm-rise mt-5 text-sm leading-6 text-muted-foreground [animation-delay:160ms]">{hint}</p> : null}
				{children ? <div className="fm-rise mt-8 w-full max-w-sm [animation-delay:220ms]">{children}</div> : null}
			</div>
		</div>
	);
}
