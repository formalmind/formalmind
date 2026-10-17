import { useEffect, useRef } from "react";

/** One cloud: overlapping puffs on a flat base, drawn in a 200×80 box. */
function Cloud({ x, y, scale, opacity }: { x: number; y: number; scale: number; opacity: number }) {
	return (
		<g transform={`translate(${x} ${y}) scale(${scale})`} opacity={opacity}>
			<ellipse cx="100" cy="58" rx="96" ry="22" />
			<circle cx="62" cy="46" r="28" />
			<circle cx="104" cy="34" r="36" />
			<circle cx="146" cy="48" r="24" />
		</g>
	);
}

type CloudSpec = { x: number; y: number; scale: number; opacity: number };

/**
 * A strip of clouds twice the viewport wide, the second half a copy of the first, so sliding it left by half loops
 * without a seam. `depth` sets how much the layer leans with the pointer: near layers more than far ones.
 */
function CloudLayer({ clouds, drift, depth, blur, className }: { clouds: CloudSpec[]; drift: number; depth: number; blur: number; className: string }) {
	return (
		<div className={`absolute inset-x-0 ${className}`} style={{ transform: `translate3d(calc(var(--sky-x, 0) * ${depth * -24}px), calc(var(--sky-y, 0) * ${depth * -16}px), 0)` }}>
			<svg
				viewBox="0 0 2000 240"
				preserveAspectRatio="xMidYMax slice"
				className="sky-drift h-full w-[200%] fill-white"
				style={{ animationDuration: `${drift}s`, filter: blur ? `blur(${blur}px)` : undefined }}
				aria-hidden
			>
				{[0, 1000].map((offset) => (
					<g key={offset} transform={`translate(${offset} 0)`}>
						{clouds.map((c, i) => <Cloud key={i} {...c} />)}
					</g>
				))}
			</svg>
		</div>
	);
}

const FAR: CloudSpec[] = [
	{ x: 20, y: 120, scale: 1.1, opacity: 0.6 },
	{ x: 330, y: 100, scale: 0.8, opacity: 0.55 },
	{ x: 560, y: 130, scale: 1.3, opacity: 0.6 },
	{ x: 820, y: 110, scale: 0.9, opacity: 0.55 },
];
const MID: CloudSpec[] = [
	{ x: -40, y: 130, scale: 1.6, opacity: 0.85 },
	{ x: 380, y: 140, scale: 1.3, opacity: 0.8 },
	{ x: 700, y: 120, scale: 1.8, opacity: 0.85 },
];
const NEAR: CloudSpec[] = [
	{ x: 60, y: 150, scale: 2.4, opacity: 1 },
	{ x: 560, y: 160, scale: 2.8, opacity: 1 },
];

/**
 * The landing page's backdrop: a soft blue sky with three layers of clouds below the demo, each drifting at its own
 * pace and leaning a little with the pointer, so the board seems to float above them. Holds still for reduced motion.
 */
export function SkyBackdrop() {
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const el = ref.current;
		if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
		let frame = 0;
		let px = 0;
		let py = 0;
		const write = () => {
			frame = 0;
			el.style.setProperty("--sky-x", px.toFixed(3));
			el.style.setProperty("--sky-y", py.toFixed(3));
		};
		const move = (e: PointerEvent) => {
			px = e.clientX / window.innerWidth - 0.5;
			py = e.clientY / window.innerHeight - 0.5;
			if (!frame) frame = requestAnimationFrame(write);
		};
		window.addEventListener("pointermove", move, { passive: true });
		return () => {
			window.removeEventListener("pointermove", move);
			cancelAnimationFrame(frame);
		};
	}, []);

	return (
		<div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
			{/* Sky: clear blue up high, paling toward the horizon behind the demo. */}
			<div className="absolute inset-0 bg-gradient-to-b from-sky-300/80 via-sky-200/70 to-sky-100" />
			<div
				className="absolute left-1/2 top-[40%] size-[60vmax] rounded-full bg-white/80 blur-3xl"
				style={{ transform: "translate3d(calc(-50% + var(--sky-x, 0) * -8px), calc(var(--sky-y, 0) * -10px), 0)" }}
			/>
			<CloudLayer clouds={FAR} drift={180} depth={0.3} blur={2} className="bottom-[24%] h-40" />
			<CloudLayer clouds={MID} drift={120} depth={0.6} blur={1} className="bottom-[8%] h-48" />
			<CloudLayer clouds={NEAR} drift={80} depth={1} blur={0} className="-bottom-12 h-56" />
		</div>
	);
}
