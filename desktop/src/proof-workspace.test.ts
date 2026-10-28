import { describe, expect, test } from "bun:test";
import { cursorPosition, positionOffset } from "./proof-workspace";

describe("Lean cursor positions", () => {
	test("uses UTF-16 columns for astral characters", () => {
		const text = "-- 🦀\ntheorem x : True := by\n  trivial";
		expect(cursorPosition(text, 5)).toEqual({ line: 0, character: 5 });
		expect(cursorPosition(text, text.indexOf("theorem"))).toEqual({ line: 1, character: 0 });
		const offset = text.indexOf("trivial") + 3;
		expect(positionOffset(text, cursorPosition(text, offset))).toBe(offset);
	});
	test("retains CRLF offsets and clamps beyond the end of a line", () => {
		const text = "first\r\nsecond";
		expect(positionOffset(text, { line: 1, character: 2 })).toBe(9);
		expect(positionOffset(text, { line: 1, character: 50 })).toBe(text.length);
	});
});
