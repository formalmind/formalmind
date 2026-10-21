/**
 * A project's repository kept in the browser: a shallow clone (isomorphic-git) stored in IndexedDB (lightning-fs),
 * fetched through the Worker's read-only git proxy (/api/projects/git). The file tree and files are read from it, so
 * the web app works from what it already has when the GitHub API is slow or failing, and only syncs in the background.
 * Nothing is checked out: files are read straight from the git objects of the last fetched commit.
 */

export type RepoTree = { files: string[]; truncated: boolean };

/** Folders the tree leaves out, as the server's listing does (server/routes/projects/tree/route.ts). */
const SKIP = new Set([".git", "node_modules", "lib", "dependencies", "out", "cache", "target", ".lake", "dist", "broadcast", ".next"]);
const LIMIT = 5000;
/** The commit the tree and files are read from, written after every clone or fetch. */
const LATEST = "refs/heads/fm-latest";
/** A repository syncs at most this often per visit; the cached copy serves in between. */
const SYNC_EVERY_MS = 5 * 60 * 1000;

type Git = typeof import("isomorphic-git");
type Kit = { git: Git; fs: InstanceType<typeof import("@isomorphic-git/lightning-fs")>; http: import("isomorphic-git").HttpClient };
let kit: Promise<Kit> | null = null;

/** isomorphic-git and its IndexedDB file system load on first use, so pages that never read a repo don't ship them. */
function load(): Promise<Kit> {
	kit ??= (async () => {
		// isomorphic-git expects Node's Buffer, so it is in place before the library loads.
		const { Buffer } = await import("buffer");
		(globalThis as { Buffer?: unknown }).Buffer ??= Buffer;
		return Promise.all([import("isomorphic-git"), import("isomorphic-git/http/web"), import("@isomorphic-git/lightning-fs")]);
	})().then(([git, web, { default: FS }]) => {
		// git asks for <url>/info/refs and <url>/git-upload-pack; both go to the Worker's proxy instead.
		const http: import("isomorphic-git").HttpClient = {
			request: (req) => {
				const u = new URL(req.url);
				const repo = u.pathname.replace(/^\/__git\//, "").replace(/\/(info\/refs|git-upload-pack)$/, "");
				const op = u.pathname.endsWith("/info/refs") ? "info/refs" : "git-upload-pack";
				// Relative, so the apps' fetch (desktop/src/api.ts) sends it to formal.team with their token.
				const to = `/api/projects/git?repo=${encodeURIComponent(repo)}&op=${op}${op === "info/refs" ? "&service=git-upload-pack" : ""}`;
				return web.default.request({ ...req, url: to });
			},
		};
		return { git, fs: new FS("fm-git"), http };
	});
	return kit;
}

const dirOf = (repo: string) => `/${repo}`;
// Only a name for git: every request is rewritten to the proxy above. https, because isomorphic-git takes no other
// scheme (the apps' webviews are tauri://localhost).
const urlOf = (repo: string) => `https://formal.team/__git/${repo}`;

async function latest(k: Kit, repo: string): Promise<string | null> {
	return k.git.resolveRef({ fs: k.fs, dir: dirOf(repo), ref: LATEST }).catch(() => null);
}

const syncing = new Map<string, Promise<string>>();
const syncedAt = new Map<string, number>();

/** Clones the repository the first time (shallow, default branch, no checkout), fetches the newest commit after that. */
export function syncRepo(repo: string): Promise<string> {
	const running = syncing.get(repo);
	if (running) return running;
	const job = (async () => {
		const k = await load();
		const dir = dirOf(repo);
		const opts = { fs: k.fs, http: k.http, dir, url: urlOf(repo), depth: 1, singleBranch: true };
		let head: string;
		if (await latest(k, repo)) {
			const res = await k.git.fetch({ ...opts, tags: false });
			head = res.fetchHead ?? (await k.git.resolveRef({ fs: k.fs, dir, ref: "HEAD" }));
		} else {
			await k.git.clone({ ...opts, noCheckout: true });
			head = await k.git.resolveRef({ fs: k.fs, dir, ref: "HEAD" });
		}
		await k.git.writeRef({ fs: k.fs, dir, ref: LATEST, value: head, force: true });
		syncedAt.set(repo, Date.now());
		return head;
	})().finally(() => syncing.delete(repo));
	syncing.set(repo, job);
	return job;
}

/** Whether this visit has synced the repository recently enough to skip another round. */
export const freshEnough = (repo: string) => Date.now() - (syncedAt.get(repo) ?? 0) < SYNC_EVERY_MS;

/** The files of the last fetched commit, or null when the browser has no copy yet. */
export async function cachedTree(repo: string): Promise<RepoTree | null> {
	const k = await load();
	const oid = await latest(k, repo);
	if (!oid) return null;
	const all = await k.git.listFiles({ fs: k.fs, dir: dirOf(repo), ref: oid });
	const files = all.filter((p) => !p.split("/").slice(0, -1).some((d) => SKIP.has(d)));
	return { files: files.slice(0, LIMIT), truncated: files.length > LIMIT };
}

/** One file of the last fetched commit as bytes (a PDF, an image), or null when it isn't in the browser's copy. */
export async function cachedBytes(repo: string, path: string): Promise<Uint8Array | null> {
	const k = await load();
	const oid = await latest(k, repo);
	if (!oid) return null;
	try {
		const { blob } = await k.git.readBlob({ fs: k.fs, dir: dirOf(repo), oid, filepath: path });
		return blob;
	} catch {
		return null;
	}
}

/** One file of the last fetched commit as text, or null when it isn't in the browser's copy. */
export async function cachedFile(repo: string, path: string): Promise<string | null> {
	const bytes = await cachedBytes(repo, path);
	return bytes ? new TextDecoder().decode(bytes) : null;
}

/** The last fetched commit, or null when the browser has no copy yet. */
export async function cachedCommit(repo: string): Promise<string | null> {
	return latest(await load(), repo);
}

/** The last fetched commit in full, for the AST (lib/browser-ast.ts): every file, its submodules, and the text of some. */
export type RepoSnapshot = { commit: string; paths: string[]; gitlinks: { path: string; oid: string }[]; text: Record<string, string> };

/** Folders the AST never reads from the repository's own files (build output, packages). */
const SNAPSHOT_SKIP = new Set([".git", "node_modules", ".lake", "out", "cache", "broadcast", "target", "dist", ".next"]);

/**
 * Every file of the last fetched commit (no limit, lib/ and dependencies/ included), its submodules (path and pinned
 * commit), and the text of the files `want` picks; null when the browser has no copy yet.
 */
export async function cachedSnapshot(repo: string, want: (path: string) => boolean): Promise<RepoSnapshot | null> {
	const k = await load();
	const oid = await latest(k, repo);
	if (!oid) return null;
	const snap: RepoSnapshot = { commit: oid, paths: [], gitlinks: [], text: {} };
	const decoder = new TextDecoder();
	await k.git.walk({
		fs: k.fs,
		dir: dirOf(repo),
		trees: [k.git.TREE({ ref: oid })],
		map: async (path, [entry]) => {
			if (!entry || path === ".") return true;
			if (SNAPSHOT_SKIP.has(path.split("/").pop() ?? "")) return null;
			const type = await entry.type();
			if (type === "commit") snap.gitlinks.push({ path, oid: await entry.oid() });
			else if (type === "blob") {
				snap.paths.push(path);
				if (want(path)) {
					const bytes = await entry.content();
					if (bytes) snap.text[path] = decoder.decode(bytes);
				}
			}
			return true;
		},
	});
	return snap;
}
