/* tslint:disable */
/* eslint-disable */
/**
 * solc's standard JSON input for the entry file and the version to compile it with: `{ input, version }`.
 */
export function input(files: string, entry: string): string;
/**
 * `ast_formal`: the Lean model's coverage of the entry contract.
 */
export function formal(files: string, entry: string, solc_output: string): string;
/**
 * The scripts `ast_scripts` compiles, each on its own.
 */
export function script_files(files: string): string;
/**
 * `ast_units`, with every unit's slice (`slices`, by unit name) for `ast_slice`.
 */
export function units(files: string, entry: string, solc_output: string): string;
/**
 * `ast_scripts`, given solc's outputs (`outputs`, a JSON array: several scripts can share one) and, by script path,
 * the index of its output or why it didn't compile (`by_script`: `{ "script/A.s.sol": 0, "script/B.s.sol": "…" }`).
 */
export function scripts(files: string, outputs: string, by_script: string): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly formal: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly input: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  readonly script_files: (a: number, b: number) => [number, number, number, number];
  readonly scripts: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly units: (a: number, b: number, c: number, d: number, e: number, f: number) => [number, number, number, number];
  readonly __wbindgen_export_0: WebAssembly.Table;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
