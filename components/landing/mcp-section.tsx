import { useState } from "react";
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
			<InstallBlock />
			<p className="mt-4 text-center text-sm">
				<a href="/docs/agents" className="inline-flex items-center gap-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
					Agents and MCP <ArrowRight className="size-3.5" />
				</a>
			</p>
		</section>
	);
}
