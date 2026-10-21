/**
 * solc in the browser: the official soljson build of the version a project pins (binaries.soliditylang.org), called
 * through its C interface the way solc-js does. It takes the same standard JSON the Mac app gives native solc.
 */

const BIN = "https://binaries.soliditylang.org/bin";

type Soljson = {
	cwrap: (name: string, ret: string | null, args: string[]) => (...a: unknown[]) => unknown;
	addFunction: (f: (...a: number[]) => void, sig: string) => number;
	removeFunction: (p: number) => void;
	lengthBytesUTF8: (s: string) => number;
	stringToUTF8: (s: string, p: number, n: number) => void;
	setValue: (p: number, v: number, type: string) => void;
	UTF8ToString: (p: number) => string;
};

/** A source solc asked for: its text, or why there is none. */
export type Read = { contents: string } | { error: string };
export type Compile = (input: string, read: (path: string) => Read) => string;

let list: Promise<{ releases: Record<string, string>; latestRelease: string }> | null = null;
const releases = () => (list ??= fetch(`${BIN}/list.json`).then((r) => (r.ok ? r.json() : Promise.reject(`solc's release list didn't load (${r.status}).`))));

const parse = (v: string) => v.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/** Whether `version` meets one comparator set of a pragma (`^0.8.0`, `>=0.8.20 <0.9.0`, `=0.8.26`, `0.8.26`, …). */
function meets(version: string, spec: string): boolean {
	const v = parse(version);
	const parts = spec.replace(/(>=|<=|>|<|=|\^|~)\s+/g, "$1").split(/\s+/).filter(Boolean);
	return parts.every((p) => {
		const m = p.match(/^(>=|<=|>|<|=|\^|~)?(.*)$/)!;
		const op = m[1] ?? "=";
		const w = parse(m[2]);
		const c = cmp(v, w);
		switch (op) {
			case ">=":
				return c >= 0;
			case "<=":
				return c <= 0;
			case ">":
				return c > 0;
			case "<":
				return c < 0;
			case "^":
				// ^0.8.x stays below 0.9.0; ^1.x below 2.0.0.
				return c >= 0 && (w[0] > 0 ? v[0] === w[0] : v[1] === w[1]);
			case "~":
				return c >= 0 && v[0] === w[0] && v[1] === w[1];
			default:
				return c === 0;
		}
	});
}

/**
 * The version to compile with: the pinned one (foundry.toml or an exact pragma), else the newest release the entry's
 * pragma allows, else the newest release.
 */
export async function pickVersion(pinned: string | null, entrySource: string): Promise<string> {
	if (pinned) return pinned.replace(/^v/, "");
	const { releases: all, latestRelease } = await releases();
	const spec = entrySource.match(/^\s*pragma\s+solidity\s+([^;]+);/m)?.[1];
	if (!spec) return latestRelease;
	const ok = Object.keys(all)
		.filter((v) => spec.split("||").some((s) => meets(v, s.trim())))
		.sort((a, b) => cmp(parse(b), parse(a)));
	return ok[0] ?? latestRelease;
}

const loaded = new Map<string, Promise<Compile>>();

/** solc `version`, loaded once (about 9 MB, kept in the Cache API so the next visit doesn't download it again). */
export function loadSolc(version: string, getText: (url: string) => Promise<string> = cachedText): Promise<Compile> {
	let job = loaded.get(version);
	if (!job) {
		job = (async () => {
			const file = (await releases()).releases[version];
			if (!file) throw `solc ${version} isn't a released version.`;
			const text = await getText(`${BIN}/${file}`);
			// soljson is an Emscripten script that sets a global `Module`; run here, it reads as plain (not Node, not a
			// page), and its wasm is inlined, so it is ready as soon as it has run.
			const M = new Function("process", "require", "module", "exports", `${text}\nreturn Module;`)(undefined, undefined, undefined, undefined) as Soljson;
			return bind(M);
		})();
		job.catch(() => loaded.delete(version));
		loaded.set(version, job);
	}
	return job;
}

async function cachedText(url: string): Promise<string> {
	const cache = typeof caches === "undefined" ? null : await caches.open("fm-solc").catch(() => null);
	const hit = await cache?.match(url);
	if (hit) return hit.text();
	const res = await fetch(url);
	if (!res.ok) throw `solc didn't download (${res.status}).`;
	await cache?.put(url, res.clone()).catch(() => {});
	return res.text();
}

/** `solidity_compile` with a read callback, as solc-js binds it for 0.6 and later. */
function bind(M: Soljson): Compile {
	const compile = M.cwrap("solidity_compile", "string", ["string", "number", "number"]) as (input: string, cb: number, ctx: number) => string;
	const alloc = M.cwrap("solidity_alloc", "number", ["number"]) as (n: number) => number;
	const reset = M.cwrap("solidity_reset", null, []) as () => void;
	const copy = (s: string, ptr: number) => {
		const n = M.lengthBytesUTF8(s) + 1;
		const buf = alloc(n);
		M.stringToUTF8(s, buf, n);
		M.setValue(ptr, buf, "*");
	};
	return (input, read) => {
		const cb = M.addFunction((_ctx, kind, data, contents, error) => {
			if (M.UTF8ToString(kind) !== "source") return copy("Only sources can be read.", error);
			const r = read(M.UTF8ToString(data));
			if ("contents" in r) copy(r.contents, contents);
			else copy(r.error, error);
		}, "viiiii");
		try {
			return compile(input, cb, 0);
		} finally {
			M.removeFunction(cb);
			reset();
		}
	};
}
