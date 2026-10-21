#!/usr/bin/env bun
/**
 * Builds the localhost demo's data from real repositories: each one's file tree, the text of its own sources,
 * and formal-ast's audit (units, clusters, slices) for each source contract.
 *
 *   bun scripts/demo-data.ts ../contracts ../v2-proofs     (default: ~/developer/asyncswap/contracts)
 *   bun scripts/demo-data.ts --add ../another-repo         (keeps the repos already built, adds or refreshes this one)
 *
 * Writes components/demo/data.json ({ repos: [...] }), which the /local-demo page and the sidebar's Local list load.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const args = process.argv.slice(2);
const adding = args.includes("--add");
const roots = args.filter((a) => a !== "--add").map((a) => resolve(a));
if (!roots.length) roots.push(join(process.env.HOME ?? "", "developer/asyncswap/contracts"));

/** One repository's demo data. */
function build(root: string) {
	const SKIP = /^(dependencies|lib|node_modules|out|cache|broadcast|\.github)\//;
	const files = execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" })
		.split("\n")
		.filter((f) => f && !SKIP.test(f));

	// The repository's own text files, small enough to ship in a demo.
	const sources: Record<string, string> = {};
	for (const f of files) {
		if (!/\.(sol|lean|toml|txt|md|json|ts|sh)$/.test(f)) continue;
		if (statSync(join(root, f)).size > 120_000) continue;
		sources[f] = readFileSync(join(root, f), "utf8");
	}

	// Its images, for Markdown previews (up to 4 MB each).
	const MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };
	const images: Record<string, string> = {};
	for (const f of files) {
		const mime = MIME[f.split(".").pop()?.toLowerCase() ?? ""];
		if (!mime || statSync(join(root, f)).size > 4_000_000) continue;
		images[f] = `data:${mime};base64,${readFileSync(join(root, f)).toString("base64")}`;
	}

	// formal-ast's audit and Lean coverage for every contract under src/.
	const bin = resolve(import.meta.dir, "../crates/formal-ast/target/release/formal-ast");
	const audits: Record<string, unknown> = {};
	const formals: Record<string, unknown> = {};
	for (const f of files.filter((f) => f.startsWith("src/") && f.endsWith(".sol"))) {
		try {
			audits[f] = JSON.parse(execFileSync(bin, ["--root", root, f, "audit"], { encoding: "utf8", maxBuffer: 64 << 20 }));
			formals[f] = JSON.parse(execFileSync(bin, ["--root", root, f, "formal"], { encoding: "utf8", maxBuffer: 64 << 20 }));
		} catch {
			// Files without a deployable contract (libraries, interfaces, types) have no audit.
		}
	}

	// Production's entry points, from the Foundry scripts.
	let scripts: unknown = null;
	try {
		scripts = JSON.parse(execFileSync(bin, ["--root", root, "x", "scripts"], { encoding: "utf8", maxBuffer: 64 << 20 }));
	} catch {
		// No script/ folder.
	}
	return { name: basename(root), path: root, files, sources, images, audits, formals, scripts };
}

const out = resolve(import.meta.dir, "../components/demo/data.json");
// With --add, the repos already built stay (one with the same path is rebuilt).
const before: { path: string }[] = adding && existsSync(out) ? (() => {
	const old = JSON.parse(readFileSync(out, "utf8"));
	return Array.isArray(old.repos) ? old.repos : [old];
})() : [];
const repos: unknown[] = before.filter((r) => !roots.includes(r.path));
for (const root of roots) {
	const repo = build(root);
	repos.push(repo);
	console.log(`${repo.name}: ${repo.files.length} files, ${Object.keys(repo.sources).length} sources, ${Object.keys(repo.images).length} images, ${Object.keys(repo.audits).length} audits`);
}
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify({ repos }));
console.log(`${out}: ${repos.length} repos, ${(statSync(out).size / 1024).toFixed(0)} KB`);
