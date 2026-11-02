import { useId } from "react";

const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;
/** Where the stack's back corner lands in the viewBox. */
const ORIGIN = [112, 346];
/** Each layer's size, thickness and height above the one below, and the three blocks' size and places on it. */
const LAYER = { w: 544, d: 112, h: 8, gap: 150 };
const BLOCK = { w: 160, d: 74, y: 10 };
const COLUMNS = [14, 192, 370];

type Point = [x: number, y: number, z: number];

const project = ([x, y, z]: Point) => [ORIGIN[0] + (x - y) * COS, ORIGIN[1] + (x + y) * SIN - z];
const points = (corners: Point[]) => corners.map((c) => project(c).join(",")).join(" ");
/** Lays SVG text flat on a surface, reading along the x axis. */
const flat = (at: Point) => {
	const [sx, sy] = project(at);
	return `matrix(${COS} ${SIN} ${-COS} ${SIN} ${sx} ${sy})`;
};

/** A solid with its top at z + h: side faces shaded, so the top reads as lit. */
function Solid({ x, y, z, w, d, h, top, side = "stroke-foreground/25", dashed = false }: { x: number; y: number; z: number; w: number; d: number; h: number; top: string; side?: string; dashed?: boolean }) {
	const t = z + h;
	return (
		<g strokeLinejoin="round">
			<polygon points={points([[x, y + d, t], [x + w, y + d, t], [x + w, y + d, z], [x, y + d, z]])} className={`fill-muted ${side}`} />
			<polygon points={points([[x + w, y, t], [x + w, y + d, t], [x + w, y + d, z], [x + w, y, z]])} className={`fill-border ${side}`} />
			<polygon points={points([[x, y, t], [x + w, y, t], [x + w, y + d, t], [x, y + d, t]])} className={`${top} ${side}`} strokeDasharray={dashed ? "5 4" : undefined} />
		</g>
	);
}

/** One layer's plate, with its name lying along the front edge. */
function Plate({ z, label }: { z: number; label: string }) {
	const t = z + LAYER.h;
	return (
		<g>
			<Solid x={0} y={0} z={z} w={LAYER.w} d={LAYER.d} h={LAYER.h} top="fill-muted" />
			<text transform={flat([COLUMNS[0], LAYER.d - 8, t])} className="fill-muted-foreground font-mono text-[10px] uppercase tracking-wider">{label}</text>
		</g>
	);
}

/** One block standing on a plate: a name and a mono sublabel on its top. `focal` draws it in ink, `dashed` marks the pay-per-token route. */
function Block({ x, z, h, w = BLOCK.w, name, sub, focal = false, dashed = false }: { x: number; z: number; h: number; w?: number; name: string; sub: string; focal?: boolean; dashed?: boolean }) {
	const t = z + h;
	return (
		<g>
			<Solid x={x} y={BLOCK.y} z={z} w={w} d={BLOCK.d} h={h} top="fill-card" side={focal ? "stroke-foreground" : "stroke-border"} dashed={dashed} />
			<text transform={flat([x + 12, BLOCK.y + 32, t])} className="fill-foreground text-[13px] font-medium">{name}</text>
			<text transform={flat([x + 12, BLOCK.y + 52, t])} className="fill-muted-foreground font-mono text-[10px]">{sub}</text>
		</g>
	);
}

/** A straight rise between layers, from a block's top beside its name to where the plate above hides it. */
function Rise({ x, from, to, ink = false, dashed = false, marker }: { x: number; from: number; to: number; ink?: boolean; dashed?: boolean; marker: string }) {
	const cx = x + BLOCK.w - 12;
	const cy = BLOCK.y + BLOCK.d / 2;
	const [x1, y1] = project([cx, cy, from]);
	// A point under a plate shows until the plate's front edge passes in front of it, and the arrow stops there.
	const [, y2] = project([cx, cy, to - (LAYER.d - cy) - 2]);
	return <path d={`M${x1} ${y1} V${y2}`} fill="none" strokeWidth={ink ? 1.5 : 1.25} strokeDasharray={dashed ? "5 4" : undefined} className={ink ? "stroke-foreground" : "stroke-muted-foreground"} markerEnd={`url(#${marker})`} />;
}

/** Who pays for the agents, as a stack: the swarm runs on your computer, and only its model calls rise through a CLI or a key to what pays for them. */
function RoutesDiagram() {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const ink = `${id}-ink`;
	const soft = `${id}-soft`;
	const z1 = 0;
	const z2 = LAYER.gap;
	const z3 = LAYER.gap * 2;
	const plate = LAYER.h;
	const [labelX, labelY] = project([COLUMNS[2] + BLOCK.w - 12, BLOCK.y + BLOCK.d / 2, z2 + plate + 14]);
	return (
		<svg viewBox="0 0 620 684" role="img" aria-labelledby={`${id}-title ${id}-desc`} className="h-auto w-full">
			<title id={`${id}-title`}>Who pays for the agents</title>
			<desc id={`${id}-desc`}>
				Three stacked layers. The swarm runs on your computer with your files, lake and forge. Its model calls rise through your signed-in Claude Code to your Claude Pro or Max plan, through Codex to your ChatGPT Plus or Pro plan, or with an Anthropic or OpenAI key from the keychain, billed per token.
			</desc>
			<defs>
				<marker id={ink} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-foreground" />
				</marker>
				<marker id={soft} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-muted-foreground" />
				</marker>
			</defs>

			{/* Bottom to top, so each layer hides what passes behind it. */}
			<Plate z={z1} label="Your computer" />
			<Block x={COLUMNS[0]} z={z1 + plate} h={22} w={COLUMNS[2] + BLOCK.w - COLUMNS[0]} name="Agent swarm" sub="files · lake · forge" />
			{COLUMNS.map((x) => (
				<Rise key={x} x={x} from={z1 + plate + 22} to={z2} marker={soft} />
			))}

			<Plate z={z2} label="Signed in, or your key" />
			<Block x={COLUMNS[0]} z={z2 + plate} h={14} name="Claude Code" sub="agentic CLI" />
			<Block x={COLUMNS[1]} z={z2 + plate} h={14} name="Codex" sub="agentic CLI" />
			<Block x={COLUMNS[2]} z={z2 + plate} h={14} name="Keychain" sub="your API key" />
			<Rise x={COLUMNS[0]} from={z2 + plate + 14} to={z3} ink marker={ink} />
			<Rise x={COLUMNS[1]} from={z2 + plate + 14} to={z3} ink marker={ink} />
			<Rise x={COLUMNS[2]} from={z2 + plate + 14} to={z3} dashed marker={soft} />
			<text x={labelX + 10} y={labelY - 34} className="fill-muted-foreground font-mono text-[10px] uppercase tracking-wider">Model calls</text>

			<Plate z={z3} label="Paid by" />
			<Block x={COLUMNS[0]} z={z3 + plate} h={26} name="Claude Pro or Max" sub="Anthropic" focal />
			<Block x={COLUMNS[1]} z={z3 + plate} h={26} name="ChatGPT Plus or Pro" sub="OpenAI" focal />
			<Block x={COLUMNS[2]} z={z3 + plate} h={8} name="Anthropic or OpenAI" sub="billed per token" dashed />
		</svg>
	);
}

/** The landing page's "bring your own plan" section: the agents run on the Claude or ChatGPT plan you already pay for. */
export function BringYourPlan() {
	return (
		<section className="mx-auto w-full max-w-6xl shrink-0 px-4 pt-16 sm:px-6">
			<div className="mx-auto max-w-2xl text-center">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Agentic</p>
				<h2 className="mt-3 text-balance font-display text-4xl leading-[1.1] sm:text-5xl">Bring your own Claude Max or ChatGPT plan</h2>
				<p className="mx-auto mt-4 max-w-[560px] text-balance text-[15px] leading-[22px] text-muted-foreground">
					Run the agents on the Claude Code or Codex you already pay for. No API key needed.
				</p>
			</div>
			<div className="mt-10 rounded-2xl border bg-muted/60 p-1.5">
				<div className="shadow-card overflow-x-auto rounded-xl border bg-card p-4 sm:p-6">
					<div className="mx-auto min-w-[460px] max-w-[620px]">
						<RoutesDiagram />
					</div>
					<div className="mt-4 flex flex-wrap justify-center gap-x-6 gap-y-1 text-[12px] text-muted-foreground">
						<span className="flex items-center gap-2">
							<span className="w-7 shrink-0 border-t-[1.5px] border-foreground" />
							Your plan's usage limits, nothing charged to a key
						</span>
						<span className="flex items-center gap-2">
							<span className="w-7 shrink-0 border-t-[1.5px] border-dashed border-muted-foreground" />
							Billed to your key, with a spending cap
						</span>
					</div>
				</div>
			</div>
		</section>
	);
}
