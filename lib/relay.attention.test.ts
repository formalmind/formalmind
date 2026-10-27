import { describe, expect, test } from "bun:test";
import { attention } from "./relay";

describe("attention: what mac_watch returns", () => {
	test("questions, bugs, blocks, proofs, errors and endings; not ordinary progress", () => {
		expect(attention({ kind: "ask", text: "**S-08**: is this what you meant?" })).toBe("question");
		expect(attention({ kind: "bug", text: "F-1 …" })).toBe("bug");
		expect(attention({ kind: "plan", text: "item S-01.2 blocked: the proof didn't check after 3 attempts" })).toBe("blocked");
		expect(attention({ kind: "plan", text: "S-03 proved: every function it is about" })).toBe("proved");
		expect(attention({ kind: "error", text: "budget reached" })).toBe("error");
		expect(attention({ kind: "done", text: "" })).toBe("session ended");
		for (const kind of ["tool", "result", "status", "say", "context"]) expect(attention({ kind, text: "blocked proved" })).toBeNull();
		expect(attention({ kind: "plan", text: "8 items from the AST" })).toBeNull();
	});
});
