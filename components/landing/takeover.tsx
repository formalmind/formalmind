"use client";

import { useEffect, useState } from "react";
import { SwarmCursor } from "@/components/swarm/swarm-canvas";
import type { SwarmRole } from "@/lib/swarm";

/**
 * The landing page's hand-off from the hero to the live plan, played by the agents:
 * enter: three agents fly in from the edges and take hold of the hero's bottom edge;
 * drag:  they drag the hero up and off the page (the rest of the page fades);
 * grab:  they swoop down to the plan's panel, peeking at the bottom;
 * pull:  they pull it up to fill the viewport;
 * stream: they let go, and the plan streams in.
 */
export type Phase = "idle" | "enter" | "drag" | "grab" | "pull" | "stream";

const NEXT: Partial<Record<Phase, [Phase, number]>> = { enter: ["drag", 700], drag: ["grab", 800], grab: ["pull", 520], pull: ["stream", 720] };

/** Plays the phases in order from "enter"; with reduced motion it goes straight to "stream". */
export function usePhase(): [Phase, (p: Phase) => void] {
	const [phase, setPhase] = useState<Phase>("idle");
	useEffect(() => {
		const next = NEXT[phase];
		if (!next) return;
		const t = setTimeout(() => setPhase(next[0]), next[1]);
		return () => clearTimeout(t);
	}, [phase]);
	const set = (p: Phase) => setPhase(p === "enter" && typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? "stream" : p);
	return [phase, set];
}

/** Where the panel's top edge sits while it peeks from the bottom, and once it is pulled up (below the header). */
export const PEEK = 56;
export const PANEL_TOP = 72;

const AGENTS: { role: SwarmRole; at: number; from: (w: number, h: number) => [number, number]; say?: Partial<Record<Phase, string>> }[] = [
	{ role: "planner", at: 0.22, from: (_w, h) => [-80, h * 0.7], say: { enter: "Let's see it", pull: "Planning it now" } },
	{ role: "prover", at: 0.5, from: (w, h) => [w / 2, h + 60] },
	{ role: "reviewer", at: 0.78, from: (w, h) => [w + 80, h * 0.6], say: { grab: "Pull!" } },
];

/** The agents for the hand-off, over everything; `hero` is the hero's box when the play started. */
export function TakeoverAgents({ phase, hero }: { phase: Phase; hero: DOMRect | null }) {
	const [size, setSize] = useState({ w: 0, h: 0 });
	// They start off-screen and fly in on the next frame, so the move is animated.
	const [arrived, setArrived] = useState(false);
	useEffect(() => {
		setSize({ w: window.innerWidth, h: window.innerHeight });
		const id = requestAnimationFrame(() => requestAnimationFrame(() => setArrived(true)));
		return () => cancelAnimationFrame(id);
	}, []);
	if (!size.w || phase === "idle") return null;
	const { w, h } = size;
	const left = hero?.left ?? 0;
	const width = hero?.width ?? w;
	const edge = Math.min(hero?.bottom ?? h * 0.6, h - 40);
	return (
		<div className={`pointer-events-none fixed inset-0 z-50 transition-opacity duration-300 ${phase === "stream" ? "opacity-0" : "opacity-100"}`} aria-hidden>
			{AGENTS.map(({ role, at, from, say }) => {
				const x = left + width * at;
				const [fx, fy] = from(w, h);
				const [px, py] = !arrived
					? [fx, fy]
					: phase === "enter"
						? [x, edge]
						: phase === "drag"
							? [x, 40]
							: phase === "grab"
								? [w * (0.15 + at * 0.7), h - PEEK + 6]
								: [w * (0.15 + at * 0.7), PANEL_TOP + 6];
				// Leaving pulls hard (ease-in); arriving settles (ease-out).
				const ease = phase === "drag" ? "cubic-bezier(0.55,0,0.85,0.35)" : "cubic-bezier(0.22,1,0.36,1)";
				const ms = phase === "drag" ? 800 : phase === "grab" ? 500 : 700;
				return (
					<div key={role} className="absolute left-0 top-0" style={{ transform: `translate(${px}px, ${py}px)`, transition: `transform ${ms}ms ${ease}` }}>
						<SwarmCursor role={role} x={0} y={0} turn={false} say={say?.[phase]} />
					</div>
				);
			})}
		</div>
	);
}
