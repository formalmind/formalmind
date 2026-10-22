import { expect, test } from "bun:test";
import type { Formal, FormalFn } from "./swarm-panel";
import { mappedSources } from "./proof-mapping";

const fn = (file: string, line: number, theorems: number[]): FormalFn => ({ name: "C.update", kind: "function", visibility: "public", mutability: "nonpayable", entry: true, dependency: false, file, line, endLine: line + 2, solidity: "function update() {}", lean: "C.update", def: null, why: null, theorems });
const data: Formal = { contract: "C", namespace: "C", modelLines: 10, translated: 3, opaque: 0, ext: 0, ms: 0,
 functions: [fn("src/C.sol", 2, [0]), fn("lib/C.sol", 20, [1]), fn("src/C.sol", 30, [0, 1])],
 theorems: [{ name: "update_correct", file: "formal/Proof.lean", line: 8, sorry: false, text: "theorem update_correct" }, { name: "other", file: "formal/Other.lean", line: 12, sorry: true, text: "theorem other" }] };
test("uses exact theorem indices across overloaded names and different source paths", () => {
 expect(mappedSources(data, 0).map(f => [f.file, f.line])).toEqual([["src/C.sol", 2], ["src/C.sol", 30]]);
 expect(mappedSources(data, 1).map(f => [f.file, f.line])).toEqual([["lib/C.sol", 20], ["src/C.sol", 30]]);
});
test("does not invent mappings for an unknown theorem", () => {
 expect(mappedSources(data, -1)).toEqual([]);
 expect(mappedSources(data, 2)).toEqual([]);
});
