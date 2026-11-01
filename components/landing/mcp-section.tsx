import { useId, useState } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";

const SERVER = "https://formal.team/mcp/account";

/** How to add the account server, per client (as in content/docs/agents.md). `code` is what Copy copies. */
const CLIENTS = [
	{ name: "Claude Code", code: `claude mcp add --transport http --scope user formalmind ${SERVER}`, note: "Then run /mcp in a session to sign in with GitHub." },
	{ name: "Claude", code: SERVER, note: "Settings → Connectors → Add custom connector, with this URL." },
	{ name: "ChatGPT", code: SERVER, note: "Settings → Connectors, turn on Developer mode (under Advanced), then Create a connector with this URL and OAuth." },
	{ name: "Cursor", code: `{ "mcpServers": { "formalmind": { "url": "${SERVER}" } } }`, note: "Add it to ~/.cursor/mcp.json." },
];

/** A tab per client, its command or URL with Copy, and the one step after it. */
function InstallBlock() {
	const [active, setActive] = useState(0);
	const [copied, setCopied] = useState(false);
	const client = CLIENTS[active];
	const copy = () => {
		void navigator.clipboard?.writeText(client.code).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		});
	};
	return (
		<div className="mx-auto mt-6 max-w-2xl">
			<div role="tablist" aria-label="MCP client" className="flex flex-wrap justify-center gap-1">
				{CLIENTS.map((c, i) => (
					<button
						key={c.name}
						type="button"
						role="tab"
						aria-selected={i === active}
						onClick={() => {
							setActive(i);
							setCopied(false);
						}}
						className={`h-7 rounded-md px-3 text-[12px] ${i === active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
					>
						{c.name}
					</button>
				))}
			</div>
			<div role="tabpanel" className="mt-2 flex items-center gap-2 rounded-lg border bg-muted/60 py-1.5 pl-3 pr-1.5">
				<code className="min-w-0 flex-1 break-words py-1 text-left font-mono text-[12px] text-foreground">{client.code}</code>
				<button type="button" onClick={copy} title="Copy" aria-label="Copy" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
					{copied ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
				</button>
			</div>
			<p className="mt-2 text-center text-[13px] text-muted-foreground">{client.note} Turn on Settings → Remote control (MCP) in the Mac app.</p>
		</div>
	);
}

/** Isometric projection: world x runs down-right, y down-left, z up. */
const C = Math.cos(Math.PI / 6);
const iso = (x: number, y: number, z = 0) => [(x - y) * C, (x + y) / 2 - z] as const;
const pts = (list: [number, number, number][]) => list.map(([x, y, z]) => iso(x, y, z).join(",")).join(" ");

/** A world-space orthogonal route at height z, its corners rounded (the projection is affine, so a Bezier stays one). */
function isoRoute(route: [number, number][], z: number, r = 8) {
	const points = route.filter((q, i) => i === 0 || q[0] !== route[i - 1][0] || q[1] !== route[i - 1][1]);
	const p = (x: number, y: number) => iso(x, y, z).join(" ");
	let d = `M${p(...points[0])}`;
	for (let i = 1; i < points.length - 1; i++) {
		const [ax, ay] = points[i - 1], [bx, by] = points[i], [cx, cy] = points[i + 1];
		const into = Math.hypot(bx - ax, by - ay), out = Math.hypot(cx - bx, cy - by);
		if ((bx - ax) * (cy - by) === (by - ay) * (cx - bx)) continue;
		d += ` L${p(bx - ((bx - ax) / into) * r, by - ((by - ay) / into) * r)} Q${p(bx, by)} ${p(bx + ((cx - bx) / out) * r, by + ((cy - by) / out) * r)}`;
	}
	return `${d} L${p(...points[points.length - 1])}`;
}

/** Text lying flat on the plane at height z, reading along world x. */
function Flat({ x, y, z, className, children }: { x: number; y: number; z: number; className: string; children: string }) {
	const [X, Y] = iso(x, y, z);
	return <text transform={`matrix(${C} 0.5 ${-C} 0.5 ${X} ${Y})`} className={className}>{children}</text>;
}

const H = 16;

/** A raised slab: its top (a card), the two faces toward you, and its name and sublabel lying on the top. */
function Slab({ x0, y0, x1, y1, name, sub, focal = false }: { x0: number; y0: number; x1: number; y1: number; name: string; sub: string; focal?: boolean }) {
	const edge = focal ? "stroke-foreground" : "stroke-border";
	const deep = y1 - y0 > 80;
	return (
		<g strokeLinejoin="round">
			<polygon points={pts([[x1, y0, H], [x1, y1, H], [x1, y1, 0], [x1, y0, 0]])} className={`fill-border ${edge}`} />
			<polygon points={pts([[x0, y1, H], [x1, y1, H], [x1, y1, 0], [x0, y1, 0]])} className={`fill-muted ${edge}`} />
			<polygon points={pts([[x0, y0, H], [x1, y0, H], [x1, y1, H], [x0, y1, H]])} className={`fill-card ${edge}`} strokeWidth={focal ? 1.5 : 1} />
			<Flat x={x0 + 16} y={y0 + (deep ? 40 : 26)} z={H} className="fill-foreground text-[15px] font-medium">{name}</Flat>
			<Flat x={x0 + 16} y={y0 + (deep ? 64 : 46)} z={H} className="fill-muted-foreground font-mono text-[11px]">{sub}</Flat>
		</g>
	);
}

/** Another agent, through formal.team's account MCP server, reading and steering the app on your Mac: drawn in 3D. */
function McpDiagram() {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const ink = `${id}-ink`;
	const soft = `${id}-soft`;
	// The Mac's three slabs, along y; formal.team's routes fan out to their back edges.
	const mac = [
		{ y0: -58, y1: -2, name: "Read the folder", sub: "mac_get · plan, bugs, work map" },
		{ y0: 22, y1: 78, name: "Steer the swarm", sub: "mac_do · start, pause, message" },
		{ y0: 102, y1: 158, name: "Prove a function", sub: "check_proof · submit_proof", focal: true },
	];
	return (
		<svg viewBox="-100 -30 910 556" role="img" aria-labelledby={`${id}-title ${id}-desc`} className="h-auto w-full">
			<title id={`${id}-title`}>Another agent, through MCP</title>
			<desc id={`${id}-desc`}>
				Another Claude session, ChatGPT or Cursor connects to formal.team's account MCP server, which relays to the Formal Mind app on your Mac: it reads a folder's plan, bugs and work map, steers the swarm, and checks and submits proofs.
			</desc>
			<defs>
				<marker id={ink} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-foreground" />
				</marker>
				<marker id={soft} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-muted-foreground" />
				</marker>
			</defs>

			{/* Your Mac: a dashed plot on the ground the app's slabs stand on. */}
			<polygon points={pts([[528, -82, 0], [840, -82, 0], [840, 208, 0], [528, 208, 0]])} className="fill-muted/40 stroke-border" strokeDasharray="4 4" />
			<Flat x={568} y={196} z={0} className="fill-muted-foreground font-mono text-[11px] uppercase tracking-wider">Your Mac</Flat>

			<Slab x0={0} y0={0} x1={200} y1={100} name="Another Claude session" sub="or ChatGPT · Cursor" />
			<Slab x0={280} y0={0} x1={456} y1={100} name="formal.team" sub="/mcp/account · OAuth" />
			{mac.map((m) => <Slab key={m.name} x0={568} y0={m.y0} x1={808} y1={m.y1} name={m.name} sub={m.sub} focal={m.focal} />)}

			{/* Routes run across the slabs' tops, drawn last so they bridge the gaps. */}
			<g fill="none" strokeWidth={1.25}>
				<path d={isoRoute([[200, 50], [278, 50]], H)} className="stroke-muted-foreground" markerEnd={`url(#${soft})`} />
				{mac.map((m, i) => {
					const y = (m.y0 + m.y1) / 2;
					const from = 36 + i * 14;
					return (
						<path
							key={m.name}
							d={isoRoute([[456, from], [504, from], [504, y], [566, y]], H)}
							className={m.focal ? "stroke-foreground" : "stroke-muted-foreground"}
							strokeWidth={m.focal ? 1.5 : 1.25}
							markerEnd={`url(#${m.focal ? ink : soft})`}
						/>
					);
				})}
			</g>
			<Flat x={222} y={40} z={H} className="fill-muted-foreground font-mono text-[10px] uppercase tracking-wider">MCP</Flat>
		</svg>
	);
}

/** The landing page's MCP section: Claude, ChatGPT or Cursor working with the swarm on your Mac. */
export function McpSection() {
	return (
		<section className="mx-auto w-full max-w-6xl shrink-0 px-4 pt-20 sm:px-6">
			<div className="mx-auto max-w-2xl text-center">
				<p className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Remote control</p>
				<h2 className="mt-3 text-balance font-display text-4xl leading-[1.1] sm:text-5xl">Built-in MCP server</h2>
				<p className="mx-auto mt-4 max-w-[560px] text-balance text-[15px] leading-[22px] text-muted-foreground">
					Control the app from another Claude session, or from ChatGPT or Cursor.
				</p>
			</div>
			<div className="mt-10 rounded-2xl border bg-muted/60 p-1.5">
				<div className="shadow-card overflow-x-auto rounded-xl border bg-card p-4 sm:p-6">
					<div className="mx-auto min-w-[640px] max-w-[880px]">
						<McpDiagram />
					</div>
				</div>
			</div>
			<InstallBlock />
			<p className="mt-4 text-center text-sm">
				<a href="/docs/agents" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
					Agents and MCP <ArrowRight className="size-3.5" />
				</a>
			</p>
		</section>
	);
}
