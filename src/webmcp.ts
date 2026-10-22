/* WebMCP: expose the read-only /mcp tools to an agent driving this page
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
		name: "formalmind_audit_format",
		title: "Audit format",
		description: "The formalmind.audit/v1 format: one JSON file per audit report, with every finding's status in the current code, PoC and fix, and for Formal Mind's own audit the Proofs coverage and the properties proved.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		execute: (_input, o) => callTool("get_audit_format", {}, o?.signal),
	},
	{
		name: "formalmind_example_audit",
		title: "Example audit",
		description: "Formal Mind's audit of Async Swap's contracts (asyncswap/contracts, audit/formal-mind.audit.json): a summary, or its findings, coverage or properties.",
		inputSchema: { type: "object", properties: { section: { type: "string", enum: ["summary", "findings", "coverage", "properties", "full"], default: "summary" } } },
		annotations: { readOnlyHint: true },
		execute: (input, o) => callTool("get_example_audit", input.section ? { section: input.section } : {}, o?.signal),
	},
	{
		name: "formalmind_app_release",
		title: "Desktop app release",
		description: "The Formal Mind desktop app's latest release: version, date, notes, and the macOS and Windows downloads.",
		inputSchema: { type: "object", properties: {} },
		annotations: { readOnlyHint: true },
		execute: (_input, o) => callTool("get_app_release", {}, o?.signal),
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
