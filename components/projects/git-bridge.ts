import type { Bridge } from "@/desktop/src/swarm-panel";
import { cachedBytes, cachedFile, cachedTree, freshEnough, syncRepo } from "@/lib/browser-git";

/** Files the Code tab shows as themselves: PDFs in the browser's viewer, images as images. */
const MIME: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", avif: "image/avif", ico: "image/x-icon" };

/**
 * The folder page's bridge on the website, for an imported repository: everything is read from the browser's git copy
 * (lib/browser-git.ts). Code and Bugs work from the files; Proofs reads the Solidity AST built in the browser
 * (lib/browser-ast.ts: formal-ast and solc-js in a Web Worker); the local swarm lives in the Mac app.
 */
export function makeGitBridge(repo: string): Bridge {
	const ready = async () => {
		if (!freshEnough(repo) || !(await cachedTree(repo).catch(() => null))) await syncRepo(repo).catch(() => {});
	};
	const text = async (path: string) => {
		const t = (await cachedFile(repo, path)) ?? (await ready().then(() => cachedFile(repo, path)));
		if (t === null) throw `${path} isn't in ${repo}.`;
		return t;
	};
	return {
		apiBase: () => "",
		listen: async () => () => {},
		invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
			const path = String(args?.path ?? "");
			switch (cmd) {
				case "folder_tree": {
					await ready();
					return ((await cachedTree(repo)) ?? { files: [], truncated: false }) as T;
				}
				case "folder_read":
					return (await text(path)) as T;
				case "folder_image": {
					const type = MIME[path.split(".").pop()?.toLowerCase() ?? ""];
					if (!type) throw "Not an image or a PDF.";
					const bytes = (await cachedBytes(repo, path)) ?? (await ready().then(() => cachedBytes(repo, path)));
					if (!bytes) throw `${path} isn't in ${repo}.`;
					return URL.createObjectURL(new Blob([bytes as BlobPart], { type })) as T;
				}
				case "swarm_bugs": {
					// The swarm's findings are Markdown files under .formal/bugs, each titled by its first heading.
					const files = ((await cachedTree(repo))?.files ?? []).filter((f) => f.startsWith(".formal/bugs/") && f.endsWith(".md"));
					const bugs = await Promise.all(
						files.map(async (file) => {
							const body = await text(file).catch(() => "");
							return { file, title: body.match(/^#\s+(.+)$/m)?.[1] ?? file.split("/").pop(), body };
						}),
					);
					return bugs as T;
				}
				case "swarm_plan":
				case "swarm_running":
				case "swarm_sessions":
				case "swarm_history":
					return [] as T;
				case "swarm_proofs":
				case "swarm_queue":
					return {} as T;
				case "anthropic_key_status":
					return false as T;
				case "lsp_definition":
					return [] as T;
				case "lsp_hover":
					return null as T;
				case "ast_units":
				case "ast_slice":
				case "ast_formal":
				case "ast_scripts":
				case "ast_diagnostics": {
					await ready();
					// solc and formal-ast load only here, the first time the Proofs tab asks.
					const { runAst } = await import("@/lib/browser-ast");
					return (await runAst(repo, { cmd, entry: args?.entry as string | undefined, function: args?.function as string | undefined })) as T;
				}
				default:
					throw `${cmd} runs in the Mac app.`;
			}
		},
	};
}
