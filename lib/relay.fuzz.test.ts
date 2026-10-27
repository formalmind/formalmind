import { describe, expect, test } from "bun:test";
import { MAC_OPS } from "./mac-ops";
import { parseCommand } from "./relay";

/**
 * parseCommand is the gate every command for the Mac passes through (the MCP's mac_* tools): whatever a
 * client sends, it must return null or a well-formed command. Fuzzed with seeded random bodies, so a failure repeats.
 */

// xorshift32: a fixed seed gives the same bodies on every run.
function rng(seed: number) {
	let x = seed >>> 0 || 1;
	return () => {
		x ^= x << 13;
		x ^= x >>> 17;
		x ^= x << 5;
		return (x >>> 0) / 0x100000000;
	};
}

const OPS = Object.keys(MAC_OPS);
const TYPES = ["say", "start", "stop", "history", "call", "", "CALL", "delete", null, 7];
const STRINGS = ["", " ", "swarm", "reviews", "hunt-1a2b", "../etc", "a b", "x".repeat(200), "s-1\n2", "ok_run-1", "🙂", "<script>", "folder/with/path", "/Users/me/morpho-blue"];

function value(r: () => number, depth = 0): unknown {
	const k = Math.floor(r() * 9);
	if (depth > 2 || k < 3) return STRINGS[Math.floor(r() * STRINGS.length)];
	if (k === 3) return Math.floor(r() * 2000) - 500;
	if (k === 4) return r() < 0.5;
	if (k === 5) return null;
	if (k === 6) return [value(r, depth + 1), value(r, depth + 1)];
	if (k === 7) return { [STRINGS[Math.floor(r() * STRINGS.length)]]: value(r, depth + 1) };
	return OPS[Math.floor(r() * OPS.length)];
}

function body(r: () => number): unknown {
	if (r() < 0.05) return value(r);
	const b: Record<string, unknown> = { type: TYPES[Math.floor(r() * TYPES.length)] };
	for (const key of ["folder", "run", "text", "goal", "budget", "op", "id", "args"]) {
		if (r() < 0.6) b[key] = value(r);
	}
	if (b.type === "call" && r() < 0.5) b.op = OPS[Math.floor(r() * OPS.length)];
	if (b.type === "call" && r() < 0.5) b.args = r() < 0.1 ? { big: "y".repeat(25_000) } : { path: "a.lean", on: true };
	return b;
}

const SAFE = /^[\w-]+$/;

describe("parseCommand under fuzzing", () => {
	test("10,000 random bodies: null or a well-formed command, never a throw", () => {
		const r = rng(20261027);
		const seen = new Set<string>();
		for (let i = 0; i < 10_000; i++) {
			const b = body(r);
			let out: ReturnType<typeof parseCommand>;
			expect(() => (out = parseCommand(b))).not.toThrow();
			if (!out!) continue;
			seen.add(out!.type);
			expect(["say", "start", "stop", "history", "call"]).toContain(out!.type);
			if ("run" in out! && out!.run) expect(out!.run).toMatch(SAFE);
			if (out!.type === "call") {
				// Only a published operation reaches the Mac, with a safe id and bounded arguments.
				expect(OPS).toContain(out!.op);
				expect(out!.id).toMatch(SAFE);
				expect(JSON.stringify(out!.args).length).toBeLessThanOrEqual(20_000);
				expect(Array.isArray(out!.args)).toBe(false);
			} else {
				expect(out!.folder.length).toBeGreaterThan(0);
			}
			if (out!.type === "say") expect(out!.text.trim().length).toBeGreaterThan(0);
			if (out!.type === "start" && out!.budget !== undefined) expect(out!.budget > 0 && out!.budget <= 1000).toBe(true);
		}
		// The fuzzer reached every kind of command, not just the rejections.
		expect([...seen].sort()).toEqual(["call", "history", "say", "start", "stop"]);
	});

	test("an op the Mac doesn't publish never gets through", () => {
		for (const op of ["rm", "eval", "token_get", "term_start", "settings_set", "__proto__", "constructor", "toString"]) {
			expect(parseCommand({ type: "call", folder: "x", id: "a1", op, args: {} })).toBeNull();
		}
	});
});
