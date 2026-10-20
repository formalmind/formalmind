#!/usr/bin/env bun
/**
 * Builds the localhost demo's data from a real repository: its file tree, the text of its own sources, and
 * formal-ast's audit (units, clusters, slices) for each source contract.
 *
 *   bun scripts/demo-data.ts ../contracts        (default: ~/developer/asyncswap/contracts)
 *
 * Writes components/demo/data.json, which the /local-demo page loads.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(process.env.HOME ?? "", "developer/asyncswap/contracts"));
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

// formal-ast's audit for every contract under src/.
const bin = resolve(import.meta.dir, "../crates/formal-ast/target/release/formal-ast");
const audits: Record<string, unknown> = {};
for (const f of files.filter((f) => f.startsWith("src/") && f.endsWith(".sol"))) {
	try {
		audits[f] = JSON.parse(execFileSync(bin, ["--root", root, f, "audit"], { encoding: "utf8", maxBuffer: 64 << 20 }));
	} catch {
		// Files without a deployable contract (libraries, interfaces, types) have no audit.
	}
}

const out = resolve(import.meta.dir, "../components/demo/data.json");
mkdirSync(resolve(out, ".."), { recursive: true });
writeFileSync(out, JSON.stringify({ name: basename(root), path: root, files, sources, audits }));
console.log(`${out}: ${files.length} files, ${Object.keys(sources).length} sources, ${Object.keys(audits).length} audits, ${(statSync(out).size / 1024).toFixed(0)} KB`);
