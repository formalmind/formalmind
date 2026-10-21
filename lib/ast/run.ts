/**
 * The Proofs tab's AST commands for an imported repository, run in the browser: formal-ast (wasm) builds solc's input
 * from the repository's files, solc-js compiles it, formal-ast reads the output. It runs in a Web Worker
 * (lib/ast/worker.ts); nothing here touches the page.
 *
 * The repository's own files come from the browser's git copy. Its git submodules (lib/, dependencies/) aren't in that
 * copy: their file lists come from GitHub's API and their files from raw.githubusercontent.com, at the exact commit
 * the repository pins, fetched as solc asks for them.
 */

import { type Compile, loadSolc, pickVersion } from "./solc";

/** What the page sends: the repository at one commit. */
export type Snapshot = {
	repo: string;
	commit: string;
	/** Every file in the repository. */
	paths: string[];
	/** The text of the files formal-ast and solc read (Solidity, Lean, foundry.toml, remappings, .gitmodules). */
	text: Record<string, string>;
	/** Submodules: where each sits and the commit it pins. */
	gitlinks: { path: string; oid: string }[];
};

export type Command = { cmd: "ast_units" | "ast_slice" | "ast_formal" | "ast_scripts"; entry?: string; function?: string };

/** formal-ast's wasm exports (lib/formal-ast-wasm). */
export type Wasm = {
	input(files: string, entry: string): string;
	units(files: string, entry: string, output: string): string;
	formal(files: string, entry: string, output: string): string;
	script_files(files: string): string;
	scripts(files: string, outputs: string, byScript: string): string;
};

/** A persistent key-value store (IndexedDB in the worker). */
export type Kv = { get<T>(key: string): Promise<T | undefined>; set(key: string, value: unknown): Promise<void> };

type Submodule = { path: string; repo: string; sha: string; listed: boolean };

/** A download that failed: the result isn't kept, so the next try downloads again. */
class Offline {
	constructor(readonly message: string) {}
	toString() {
		return this.message;
	}
}
type Tree = { paths: string[]; gitlinks: { path: string; oid: string }[]; gitmodules: string | null };

/** `[submodule "x"] path = … url = …` → path → GitHub `owner/name`, for the GitHub-hosted ones. */
function gitmodules(text: string, parent: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const block of text.split(/^\s*\[submodule\b/m).slice(1)) {
		const path = block.match(/^\s*path\s*=\s*(.+?)\s*$/m)?.[1];
		let url = block.match(/^\s*url\s*=\s*(.+?)\s*$/m)?.[1];
		if (!path || !url) continue;
		// A relative URL is a sibling of the parent repository on the same host.
		if (url.startsWith("../")) url = `https://github.com/${parent.split("/")[0]}/${url.slice(3)}`;
		const m = url.match(/github\.com[:/]+([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
		if (m) out.set(path.replace(/\/+$/, ""), `${m[1]}/${m[2]}`);
	}
	return out;
}

export function makeRunner(wasm: Wasm, kv: Kv, net: { fetch: (url: string, init?: RequestInit) => Promise<Response> } = { fetch: (url, init) => fetch(url, init) }) {
	/** A submodule's files and the submodules it pins, from GitHub's API (kept forever: a commit doesn't change). */
	async function tree(repo: string, sha: string): Promise<Tree | null> {
		const key = `tree:${repo}@${sha}`;
		const hit = await kv.get<Tree>(key);
		if (hit) return hit;
		const res = await net.fetch(`https://api.github.com/repos/${repo}/git/trees/${sha}?recursive=1`, { headers: { Accept: "application/vnd.github+json" } }).catch(() => null);
		if (!res?.ok) return null;
		const body = (await res.json()) as { tree: { path: string; type: string; sha: string }[] };
		const t: Tree = {
			paths: body.tree.filter((e) => e.type === "blob").map((e) => e.path),
			gitlinks: body.tree.filter((e) => e.type === "commit").map((e) => ({ path: e.path, oid: e.sha })),
			gitmodules: null,
		};
		if (t.paths.includes(".gitmodules")) t.gitmodules = await raw(repo, sha, ".gitmodules");
		await kv.set(key, t);
		return t;
	}

	/** One file of a GitHub repository at a commit, or null when it isn't there. */
	async function raw(repo: string, sha: string, path: string): Promise<string | null> {
		const key = `file:${repo}@${sha}/${path}`;
		const hit = await kv.get<string | null>(key);
		if (hit !== undefined) return hit;
		const res = await net.fetch(`https://raw.githubusercontent.com/${repo}/${sha}/${path.split("/").map(encodeURIComponent).join("/")}`).catch(() => null);
		if (!res || (!res.ok && res.status !== 404)) throw new Offline(`${path} didn't download from ${repo} (${res?.status ?? "offline"}).`);
		const text = res.ok ? await res.text() : null;
		await kv.set(key, text);
		return text;
	}

	/**
	 * The project as formal-ast sees it: the repository's files, with every submodule's (nested ones too) listed, and
	 * the remappings.txt each dependency brings read.
	 */
	async function project(s: Snapshot) {
		const paths = new Set(s.paths);
		const text: Record<string, string> = { ...s.text };
		const subs: Submodule[] = [];
		const walk = async (prefix: string, repo: string, links: Tree["gitlinks"], modules: string | null) => {
			const urls = gitmodules(modules ?? "", repo);
			await Promise.all(
				links.map(async ({ path, oid }) => {
					const at = prefix + path;
					// The folder is there even when its listing can't be had (it is at least the gitlink itself).
					paths.add(at);
					const sub = urls.get(path);
					if (!sub) return;
					const t = await tree(sub, oid);
					subs.push({ path: at, repo: sub, sha: oid, listed: !!t });
					if (!t) return;
					for (const p of t.paths) paths.add(`${at}/${p}`);
					await walk(`${at}/`, sub, t.gitlinks, t.gitmodules);
				}),
			);
		};
		await walk("", s.repo, s.gitlinks, s.text[".gitmodules"] ?? null);
		// The longest submodule path a file is under says where to download it from.
		subs.sort((a, b) => b.path.length - a.path.length);
		const owner = (path: string) => subs.find((m) => path.startsWith(`${m.path}/`));
		const fetchFile = async (path: string) => {
			if (path in text) return;
			const m = owner(path);
			const t = m ? await raw(m.repo, m.sha, path.slice(m.path.length + 1)) : null;
			if (t !== null) text[path] = t;
		};
		// A dependency's own remappings.txt (formal-ast scopes them to imports from inside it).
		await Promise.all([...paths].filter((p) => /^[^/]+\/[^/]+\/remappings\.txt$/.test(p)).map(fetchFile));
		// Without a submodule's listing (GitHub's API refused), its files are still downloaded as solc asks for them,
		// but the result isn't kept: remappings into it may have been missed.
		return { paths, text, owner, fetchFile, partial: subs.some((m) => !m.listed) };
	}

	type Project = Awaited<ReturnType<typeof project>>;
	const filesJson = (p: Project) => JSON.stringify({ paths: [...p.paths], text: p.text });

	type Input = { language: string; sources: Record<string, unknown>; settings: Record<string, unknown> };

	/** solc's input for an entry and the solc to compile it with. */
	async function prepare(p: Project, entry: string): Promise<{ input: Input; solc: Compile; version: string }> {
		const { input, version } = JSON.parse(wasm.input(filesJson(p), entry)) as { input: Input; version: string | null };
		const v = await pickVersion(version, p.text[entry] ?? "");
		return { input, solc: await loadSolc(v), version: v };
	}

	/** solc's errors in an output, as formal-ast words them. */
	const errorsOf = (out: string, entry: string): string | null => {
		const errors = ((JSON.parse(out) as { errors?: { severity: string; formattedMessage?: string }[] }).errors ?? []).filter((e) => e.severity === "error");
		return errors.length ? `solc failed to compile ${entry}:\n${errors.map((e) => (e.formattedMessage ?? "").trim()).join("\n\n")}` : null;
	};

	/** Formal and units requests run before the scripts' compiles, which wait while one is in progress. */
	let urgent = 0;
	const yieldTo = async (prio: "urgent" | "background") => {
		await new Promise((r) => setTimeout(r, 0));
		while (prio === "background" && urgent) await new Promise((r) => setTimeout(r, 50));
	};

	/**
	 * Downloads what an entry imports. solc asks for files as it finds imports and stops early while any is missing
	 * (cheap); the ones not read yet are downloaded and it runs again, a round per level of imports, until it has them
	 * all. The last round is a full check with no output. Returns solc's errors (a missing import, a type error), or null.
	 */
	async function gather(p: Project, solc: Compile, input: Input, entry: string, prio: "urgent" | "background"): Promise<string | null> {
		const json = JSON.stringify({ ...input, settings: { ...input.settings, outputSelection: {} } });
		for (let round = 0; round < 40; round++) {
			const missing = new Set<string>();
			await yieldTo(prio);
			const out = solc(json, (name) => {
				const path = name.replace(/^\.\//, "");
				if (path in p.text) return { contents: p.text[path] };
				const m = p.owner(path);
				if (m && (p.paths.has(path) || !m.listed)) missing.add(path);
				return { error: `File not found: ${path}` };
			});
			await Promise.all([...missing].map(p.fetchFile));
			// Nothing new could be had: solc's errors say what's missing.
			if (!missing.size || [...missing].every((m) => !(m in p.text))) return errorsOf(out, entry);
		}
		return `${entry} imports more than solc could be given.`;
	}

	/** solc's full output (AST and storage layout) once every file is there. */
	const full = (p: Project, solc: Compile, input: Input) => solc(JSON.stringify(input), (name) => {
		const path = name.replace(/^\.\//, "");
		return path in p.text ? { contents: p.text[path] } : { error: `File not found: ${path}` };
	});

	async function compile(p: Project, entry: string): Promise<string> {
		const { input, solc } = await prepare(p, entry);
		const error = await gather(p, solc, input, entry, "urgent");
		if (error) throw error;
		return full(p, solc, input);
	}

	/**
	 * Every script's output for `ast_scripts`. A full output is mostly the AST printed as JSON (seconds for a script
	 * that pulls in forge-std), so the scripts that compile are compiled together, in one output they share.
	 */
	async function compileScripts(p: Project, scripts: string[]) {
		const outputs: string[] = [];
		const byScript: Record<string, number | string> = {};
		const groups = new Map<string, { solc: Compile; input: Input; scripts: string[] }>();
		for (const script of scripts) {
			try {
				const { input, solc, version } = await prepare(p, script);
				const error = await gather(p, solc, input, script, "background");
				if (error) {
					byScript[script] = error;
					continue;
				}
				const g = groups.get(version) ?? { solc, input: { ...input, sources: {} }, scripts: [] };
				g.input.sources[script] = { urls: [script] };
				g.scripts.push(script);
				groups.set(version, g);
			} catch (e) {
				if (e instanceof Offline) throw e;
				byScript[script] = String(e);
			}
		}
		for (const g of groups.values()) {
			await yieldTo("background");
			const out = full(p, g.solc, g.input);
			if (!errorsOf(out, "")) {
				outputs.push(out);
				for (const s of g.scripts) byScript[s] = outputs.length - 1;
				continue;
			}
			// One of them doesn't compile: each on its own, so the others still do.
			for (const s of g.scripts) {
				await yieldTo("background");
				outputs.push(full(p, g.solc, { ...g.input, sources: { [s]: { urls: [s] } } }));
				byScript[s] = outputs.length - 1;
			}
		}
		return { outputs, byScript };
	}

	return async function run(s: Snapshot, c: Command): Promise<unknown> {
		const entry = c.entry ?? "";
		const key = `result:${s.repo}@${s.commit}:${c.cmd === "ast_slice" ? "ast_units" : c.cmd}:${c.cmd === "ast_scripts" ? "" : entry}`;
		let result = await kv.get<{ ok: unknown } | { error: string }>(key);
		if (!result) {
			const started = performance.now();
			let keep = true;
			const prio = c.cmd !== "ast_scripts";
			if (prio) urgent++;
			try {
				const p = await project(s);
				keep = !p.partial;
				if (c.cmd === "ast_scripts") {
					const { outputs, byScript } = await compileScripts(p, JSON.parse(wasm.script_files(filesJson(p))) as string[]);
					result = { ok: JSON.parse(wasm.scripts(filesJson(p), `[${outputs.map((o) => JSON.stringify(o)).join(",")}]`, JSON.stringify(byScript))) };
				} else {
					const out = await compile(p, entry);
					result = { ok: JSON.parse(c.cmd === "ast_formal" ? wasm.formal(filesJson(p), entry, out) : wasm.units(filesJson(p), entry, out)) };
				}
				// formal-ast has no clock in wasm; the time is the whole run's, solc included.
				const ok = result.ok as { ms?: number };
				if (c.cmd !== "ast_scripts" && ok && typeof ok === "object") ok.ms = Math.round(performance.now() - started);
			} catch (e) {
				if (e instanceof Offline) throw e.message;
				result = { error: String(e) };
			} finally {
				if (prio) urgent--;
			}
			// A failure is kept too: the same commit fails the same way.
			if (keep) await kv.set(key, result);
		}
		if ("error" in result) throw result.error;
		if (c.cmd === "ast_slice") {
			const slices = (result.ok as { slices?: Record<string, string> }).slices ?? {};
			const units = (result.ok as { units?: { name: string; function: string }[] }).units ?? [];
			const name = units.find((u) => u.name === c.function || u.function === c.function)?.name;
			if (!name) throw "no such unit";
			return slices[name];
		}
		return result.ok;
	};
}
