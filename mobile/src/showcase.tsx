import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";

/**
 * Setup shows the swarm canvas as Storybook has it, replaying a run: mounted at desktop size in a React root of its
 * own (it brings its own router), shrunk into a card, and a slow camera moves between the agents' cursors. Nothing in
 * it can be touched.
 */

const SwarmCanvas = lazy(() => import("@/components/swarm/swarm-canvas").then((m) => ({ default: m.SwarmCanvas })));

/** Where the camera looks, in the component's own pixels: the point at the centre, and how close. */
type Shot = { x: number; y: number; zoom: number };

function Stage({ label, aside, width, height, path = "/", shots, every = 3400, aspect = 0.8, children }: { label: string; aside?: string; width: number; height: number; path?: string; shots: Shot[]; every?: number; aspect?: number; children: React.ReactNode }) {
	const box = useRef<HTMLDivElement>(null);
	const mount = useRef<HTMLDivElement>(null);
	const root = useRef<Root | null>(null);
	const [boxW, setBoxW] = useState(340);
	const [i, setI] = useState(0);
	useEffect(() => {
		if (!mount.current) return;
		root.current = createRoot(mount.current);
		return () => {
			const r = root.current;
			root.current = null;
			// Unmounting a root during React's own render is refused; leave it to the next tick.
			setTimeout(() => r?.unmount());
		};
	}, []);
	useEffect(() => {
		root.current?.render(
			<MemoryRouter initialEntries={[path]}>
				<div className="dark h-full w-full bg-background text-foreground">
					<Suspense fallback={null}>{children}</Suspense>
				</div>
			</MemoryRouter>,
		);
	}, [children, path]);
	useEffect(() => {
		const el = box.current;
		if (!el) return;
		const fit = () => setBoxW(el.clientWidth);
		fit();
		const ro = new ResizeObserver(fit);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	useEffect(() => {
		if (shots.length < 2 || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
		const t = setInterval(() => setI((n) => (n + 1) % shots.length), every);
		return () => clearInterval(t);
	}, [shots.length, every]);
	const boxH = Math.round(boxW * aspect);
	const shot = shots[i] ?? shots[0];
	const k = (boxW / width) * shot.zoom;
	const tx = boxW / 2 - shot.x * k;
	const ty = boxH / 2 - shot.y * k;
	// Framed as the app's cards are: the label on the grey frame, the live view on the card inside.
	return (
		<section aria-hidden className="pointer-events-none mx-auto w-full max-w-[330px] select-none rounded-[20px] border border-white/10 bg-white/[0.05] p-1.5 shadow-[0_24px_70px_rgb(0_0_0/0.55)]">
			<header className="flex h-7 items-center px-2.5 font-mono text-[10px] font-medium uppercase tracking-wider text-white/45">
				{label}
				{aside ? <span className="ml-auto normal-case tracking-normal">{aside}</span> : null}
			</header>
			<div ref={box} className="relative w-full overflow-hidden rounded-[14px] border border-white/10 bg-background" style={{ height: boxH }}>
				<div
					ref={mount}
					className="absolute left-0 top-0 origin-top-left"
					style={{ width, height, transform: `translate(${tx}px, ${ty}px) scale(${k})`, transition: "transform 1.8s cubic-bezier(0.65, 0, 0.35, 1)" }}
				/>
			</div>
		</section>
	);
}

/** The swarm canvas replaying a run: the agents' cursors moving over the plan, from the Storybook fixture. */
export function SwarmShowcase({ close = false }: { close?: boolean }) {
	const [state, setState] = useState<unknown>(null);
	useEffect(() => void import("@/stories/fixtures/swarm").then((m) => setState(m.replayState())), []);
	const shots = close
		? [
				{ x: 380, y: 300, zoom: 2.1 },
				{ x: 760, y: 320, zoom: 2.1 },
				{ x: 560, y: 520, zoom: 1.8 },
			]
		: [
				{ x: 600, y: 420, zoom: 1 },
				{ x: 380, y: 300, zoom: 1.9 },
				{ x: 800, y: 360, zoom: 1.9 },
			];
	return (
		<Stage label="Swarm" aside="replaying a run" width={1200} height={860} shots={shots}>
			{state ? <SwarmCanvas state={state as never} fill /> : null}
		</Stage>
	);
}
