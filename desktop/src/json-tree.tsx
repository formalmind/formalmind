import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

/**
 * A JSON file as a collapsible tree: only expanded nodes render, and long arrays and objects come in pages, so
 * one-line files of any size open instantly. Invalid JSON (comments, trailing commas) returns null.
 */
export function JsonTree({ text }: { text: string }) {
	const parsed = useMemo(() => {
		try {
			return { value: JSON.parse(text) as unknown };
		} catch {
			return null;
		}
	}, [text]);
	if (!parsed) return null;
	return (
		<div className="px-4 py-3 font-mono text-[12.5px] leading-6">
			<Node name={null} value={parsed.value} depth={0} last />
		</div>
	);
}

const PAGE = 200;

function Scalar({ value }: { value: unknown }) {
	if (value === null) return <span className="text-muted-foreground">null</span>;
	if (typeof value === "string") return <span className="break-all text-emerald-700 dark:text-emerald-400">{JSON.stringify(value)}</span>;
	if (typeof value === "number") return <span className="text-sky-700 dark:text-sky-400">{String(value)}</span>;
	return <span className="text-violet-700 dark:text-violet-400">{String(value)}</span>;
}

function Node({ name, value, depth, last }: { name: string | number | null; value: unknown; depth: number; last: boolean }) {
	const isArray = Array.isArray(value);
	const isObject = value !== null && typeof value === "object";
	// The first two levels start open.
	const [open, setOpen] = useState(depth < 2);
	const [shown, setShown] = useState(PAGE);
	const key = name === null ? null : typeof name === "number" ? <span className="text-muted-foreground">{name}: </span> : <span className="text-rose-700 dark:text-rose-400">{JSON.stringify(name)}: </span>;
	const comma = last ? "" : ",";
	if (!isObject) {
		return (
			<div className="pl-4">
				{key}
				<Scalar value={value} />
				{comma}
			</div>
		);
	}
	const entries: [string | number, unknown][] = isArray ? (value as unknown[]).map((v, i) => [i, v]) : Object.entries(value as Record<string, unknown>);
	const [l, r] = isArray ? ["[", "]"] : ["{", "}"];
	if (entries.length === 0) {
		return (
			<div className="pl-4">
				{key}
				{l}
				{r}
				{comma}
			</div>
		);
	}
	return (
		<div className={depth ? "pl-4" : ""}>
			<button type="button" onClick={() => setOpen(!open)} className="-ml-4 inline-flex items-center text-left hover:text-foreground">
				<ChevronRight className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`} />
				<span className="ml-0.5">
					{key}
					{l}
				</span>
				{open ? null : (
					<span className="text-muted-foreground">
						{" "}
						{entries.length} {isArray ? (entries.length === 1 ? "item" : "items") : entries.length === 1 ? "key" : "keys"} {r}
						{comma}
					</span>
				)}
			</button>
			{open ? (
				<>
					<div className="border-l border-border/60 ml-[3px]">
						{entries.slice(0, shown).map(([k, v], i) => (
							<Node key={k} name={k} value={v} depth={depth + 1} last={i === entries.length - 1} />
						))}
						{entries.length > shown ? (
							<button type="button" onClick={() => setShown(shown + PAGE)} className="ml-4 text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
								Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown}
							</button>
						) : null}
					</div>
					<div>
						{r}
						{comma}
					</div>
				</>
			) : null}
		</div>
	);
}
