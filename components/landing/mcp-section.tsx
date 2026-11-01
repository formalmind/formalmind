import { useId, useState } from "react";
import { ArrowRight, Check, Copy } from "lucide-react";
import { Node } from "./bring-your-plan";

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
				<code className="min-w-0 flex-1 break-all py-1 text-left font-mono text-[12px] text-foreground">{client.code}</code>
				<button type="button" onClick={copy} title="Copy" aria-label="Copy" className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground">
					{copied ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
				</button>
			</div>
			<p className="mt-2 text-center text-[13px] text-muted-foreground">{client.note} Turn on Settings → Remote control (MCP) in the Mac app.</p>
		</div>
	);
}

/** Your own agent, through formal.team's account MCP server, reading and steering the app on your Mac. */
function McpDiagram() {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const ink = `${id}-ink`;
	const soft = `${id}-soft`;
	return (
		<svg viewBox="0 0 768 288" role="img" aria-labelledby={`${id}-title ${id}-desc`} className="h-auto w-full">
			<title id={`${id}-title`}>Your agent, through MCP</title>
			<desc id={`${id}-desc`}>
				Claude, ChatGPT or Cursor connects to formal.team's account MCP server, which relays to the Formal Mind app on your Mac: it reads a folder's plan, bugs and work map, steers the swarm, and checks and submits proofs.
			</desc>
			<defs>
				<marker id={ink} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-foreground" />
				</marker>
				<marker id={soft} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
					<path d="M0 1 L9 5 L0 9 Z" className="fill-muted-foreground" />
				</marker>
			</defs>

			{/* Your Mac: the app does the work, as if you'd clicked it there. */}
			<rect x={460} y={24} width={304} height={248} rx={10} className="fill-muted/40 stroke-border" strokeDasharray="4 4" />
			<text x={480} y={48} className="fill-muted-foreground font-mono text-[11px] uppercase tracking-wider">Your Mac</text>
			<text x={4} y={48} className="fill-muted-foreground font-mono text-[11px] uppercase tracking-wider">Anywhere</text>

			{/* Arrows before boxes. */}
			<g fill="none" className="stroke-muted-foreground" strokeWidth={1.25}>
				<path d="M200 156 H246" markerEnd={`url(#${soft})`} />
				<path d="M416 142 H424 Q432 142 432 134 V96 Q432 88 440 88 H482" markerEnd={`url(#${soft})`} />
				<path d="M416 156 H482" markerEnd={`url(#${soft})`} />
			</g>
			<path d="M416 170 H424 Q432 170 432 178 V216 Q432 224 440 224 H482" fill="none" className="stroke-foreground" strokeWidth={1.5} markerEnd={`url(#${ink})`} />
			<rect x={206} y={132} width={34} height={14} className="fill-background" />
			<text x={223} y={143} textAnchor="middle" className="fill-muted-foreground font-mono text-[10px] uppercase tracking-wider">MCP</text>

			<Node x={4} y={128} w={196} name="Your agent" sub="Claude · ChatGPT · Cursor" />
			<Node x={248} y={128} w={168} name="formal.team" sub="/mcp/account · OAuth" />
			<Node x={484} y={60} w={256} name="Read the folder" sub="mac_get · plan, bugs, work map" />
			<Node x={484} y={128} w={256} name="Steer the swarm" sub="mac_do · start, pause, message" />
			<Node x={484} y={196} w={256} name="Prove a function" sub="check_proof · submit_proof" focal />
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
					Connect Claude, ChatGPT or Cursor and let it steer the swarm on your Mac.
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
