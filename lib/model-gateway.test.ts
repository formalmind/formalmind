import { expect, test } from "bun:test";
import { costCents } from "@/lib/model-gateway";
test("opus 5.5 at list price", () => {
	// 1M input $4, 1M output $20, 1M cache read $0.20, 1M 5m-write $5, 1M 1h-write $8
	expect(costCents("claude-opus-5-5", { input_tokens: 1e6 })).toBeCloseTo(400);
	expect(costCents("claude-opus-5-5", { output_tokens: 1e6 })).toBeCloseTo(2000);
	expect(costCents("claude-opus-5-5", { cache_read_input_tokens: 1e6 })).toBeCloseTo(20);
	expect(costCents("claude-opus-5-5", { cache_creation_input_tokens: 1e6 })).toBeCloseTo(500);
	expect(costCents("claude-opus-5-5", { cache_creation_input_tokens: 1e6, cache_creation: { ephemeral_1h_input_tokens: 1e6 } })).toBeCloseTo(800);
	expect(costCents("claude-sonnet-5-5", { input_tokens: 1e6 })).toBeCloseTo(200);
	expect(costCents("claude-haiku-5-5", { output_tokens: 1e6 })).toBeCloseTo(50);
});
