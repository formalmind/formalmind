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

function Stage({ label, aside, width, height, path = "/", shots, every = 3400, aspect = 0.8, follow, children }: { label: string; aside?: string; width: number; height: number; path?: string; shots: Shot[]; every?: number; aspect?: number; follow?: { selector: string; zoom: number }; children: React.ReactNode }) {
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
	// Following: the camera stays on one of `follow.selector` while it moves, and only pans when it nears the frame's
	// edge; when it stops, the camera goes to whichever moved most since the last look.
	const [focus, setFocus] = useState<{ x: number; y: number } | null>(null);
	const last = useRef(new Map<Element, { x: number; y: number }>());
	const followed = useRef<Element | null>(null);
	const at = useRef<{ x: number; y: number } | null>(null);
	useEffect(() => {
		if (!follow) return;
		const t = setInterval(() => {
			const m = mount.current;
			if (!m) return;
			const base = m.getBoundingClientRect();
			const k = base.width / width;
			if (!k) return;
			let best: { el: Element; x: number; y: number; d: number } | null = null;
			let mine: { x: number; y: number; d: number } | null = null;
			for (const el of m.querySelectorAll(follow.selector)) {
				const r = el.getBoundingClientRect();
				// The arrow's tip, plus room for its name and what it says, in the component's own pixels.
				const p = { x: (r.left - base.left) / k + 30, y: (r.top - base.top) / k + 20 };
				const was = last.current.get(el);
				last.current.set(el, p);
				const d = was ? Math.hypot(p.x - was.x, p.y - was.y) : 0;
				if (el === followed.current) mine = { ...p, d };
				if (d > 8 && (!best || d > best.d)) best = { el, ...p, d };
			}
			const next = mine && mine.d > 8 ? mine : best;
			if (!next) return;
			if (next !== mine && best) followed.current = best.el;
			// Half the view's width and height, in the component's pixels: pan only once it leaves the middle.
			const view = { w: width / follow.zoom / 2, h: (width * aspect) / follow.zoom / 2 };
			const c = at.current;
			if (c && Math.abs(next.x - c.x) < view.w * 0.55 && Math.abs(next.y - c.y) < view.h * 0.55) return;
			// Never past the canvas's edges.
			const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi));
			at.current = { x: clamp(next.x, view.w, width - view.w), y: clamp(next.y, view.h, height - view.h) };
			setFocus(at.current);
		}, 2600);
		return () => clearInterval(t);
	}, [follow, width, height, aspect]);
	const boxH = Math.round(boxW * aspect);
	const shot = follow && focus ? { x: focus.x, y: focus.y, zoom: follow.zoom } : (shots[i] ?? shots[0]);
	const k = (boxW / width) * shot.zoom;
	const tx = boxW / 2 - shot.x * k;
	const ty = boxH / 2 - shot.y * k;
	// Framed as the app's cards are: the label on the grey frame, the live view on the card inside.
	return (
		<section aria-hidden className="dark pointer-events-none mx-auto w-full max-w-[330px] select-none rounded-[20px] border border-white/10 bg-white/[0.05] p-1.5 shadow-[0_24px_70px_rgb(0_0_0/0.55)]">
			<header className="flex h-7 items-center px-2.5 font-mono text-[10px] font-medium uppercase tracking-wider text-white/45">
				{label}
				{aside ? <span className="ml-auto normal-case tracking-normal">{aside}</span> : null}
			</header>
			<div ref={box} className="relative w-full overflow-hidden rounded-[14px] border border-white/10 bg-background" style={{ height: boxH }}>
				<div
					ref={mount}
					className="absolute left-0 top-0 origin-top-left"
					style={{ width, height, transform: `translate(${tx}px, ${ty}px) scale(${k})`, transition: `transform ${follow ? 2.4 : 1.8}s cubic-bezier(0.45, 0, 0.25, 1)` }}
				/>
			</div>
		</section>
	);
}

/** The agents' cursors on the canvas (components/swarm/swarm-canvas.tsx), close up. */
const FOLLOW_CURSORS = { selector: "[data-cursor]", zoom: 2.1 };

/** The swarm canvas replaying a run: the agents' cursors moving over the plan, from the Storybook fixture. */
export function SwarmShowcase() {
	const [state, setState] = useState<unknown>(null);
	useEffect(() => void import("@/stories/fixtures/swarm").then((m) => setState(m.replayState())), []);
	// Close in on the agents from the start; the camera then follows whichever is moving.
	const shots = [
		{ x: 420, y: 300, zoom: 2.1 },
	];
	return (
		<Stage label="Swarm" aside="replaying a run" width={1200} height={640} aspect={0.62} shots={shots} follow={FOLLOW_CURSORS}>
			{state ? <SwarmCanvas state={state as never} contain pace={1.8} /> : null}
		</Stage>
	);
}
