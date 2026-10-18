/* WebMCP: expose the read-only swarm tools to an agent driving this page
 * (webmachinelearning.github.io/webmcp). The spec puts the API on
 * document.modelContext; early Chrome builds used navigator.modelContext.
 * Nothing is registered when neither exists. Each tool calls the same
 * public MCP server at /mcp (worker/mcp.ts) over JSON-RPC, so the page and
 * a remote client see the same data; none of them writes anything. */

type JsonSchema = Record<string, unknown>;

interface ModelContextTool {
	name: string;
	title?: string;
	description: string;
	inputSchema?: JsonSchema;
	annotations?: { readOnlyHint?: boolean; consequentialHint?: boolean };
	execute: (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

interface ModelContext {
	registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): Promise<void> | void;
}

function modelContext(): ModelContext | null {
	const d = document as unknown as { modelContext?: ModelContext };
	const n = navigator as unknown as { modelContext?: ModelContext };
	const ctx = d.modelContext ?? n.modelContext;
	return ctx && typeof ctx.registerTool === "function" ? ctx : null;
}

/** One MCP tools/call against /mcp; the text content of the result, parsed as JSON when it is JSON. */
async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
	const res = await fetch("/mcp", {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
		signal,
	});
	if (!res.ok) throw new Error(`/mcp returned ${res.status}`);
	const body = (await res.json()) as { result?: { content?: { type: string; text?: string }[]; isError?: boolean }; error?: { message: string } };
	if (body.error) throw new Error(body.error.message);
	const text = body.result?.content?.find((c) => c.type === "text")?.text ?? "";
	if (body.result?.isError) throw new Error(text);
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const TOOLS: ModelContextTool[] = [
	{
		name: "formalmind_swarm_state",
		title: "Swarm state",
		description: "The live state of the Formal Mind swarm: projects, open work with fm: labels, merged pull requests, spend today, the chief's and the assistant's latest notes, the rebuild cycle and recent runs.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		execute: (_input, o) => callTool("get_swarm_state", {}, o?.signal),
	},
	{
		name: "formalmind_open_work",
		title: "Open work",
		description: "Open issues and pull requests the swarm is working, optionally only those carrying one fm: label (fm:todo, fm:in-progress, fm:review, fm:approved, fm:blocked, fm:rebuild, fm:finding).",
		inputSchema: { type: "object", properties: { label: { type: "string", pattern: "^fm:[a-z-]+$", description: "Only items with this label" } } },
		annotations: { readOnlyHint: true },
		execute: (input, o) => callTool("list_open_work", input.label ? { label: input.label } : {}, o?.signal),
	},
	{
		name: "formalmind_changelog",
		title: "Proofs changelog",
		description: "The latest entries of FORMAL_MIND.md in the proofs repository: what each run reconciled, changed, proved or could not prove.",
		inputSchema: { type: "object", properties: { entries: { type: "integer", minimum: 1, maximum: 50, default: 5 } } },
		annotations: { readOnlyHint: true },
		execute: (input, o) => callTool("get_changelog", input.entries ? { entries: input.entries } : {}, o?.signal),
	},
	{
		name: "formalmind_role_doc",
		title: "Role documentation",
		description: "The instructions a swarm role works from: overview, planner, prover, reviewer, merger, rebuilder, editor, consolidator, chief, assistant, answer or cycle.",
		inputSchema: {
			type: "object",
			required: ["role"],
			properties: { role: { type: "string", enum: ["overview", "planner", "prover", "reviewer", "merger", "rebuilder", "editor", "consolidator", "chief", "assistant", "answer", "cycle"] } },
		},
		annotations: { readOnlyHint: true },
		execute: (input, o) => callTool("get_role_doc", { role: input.role }, o?.signal),
	},
];

/** Registers the tools once, if the browser offers a model context. Safe to call on every load. */
export function registerWebMcpTools(): void {
	const ctx = modelContext();
	if (!ctx) return;
	for (const tool of TOOLS) {
		try {
			void ctx.registerTool(tool);
		} catch (error) {
			console.warn("[webmcp] could not register", tool.name, error);
		}
	}
}
