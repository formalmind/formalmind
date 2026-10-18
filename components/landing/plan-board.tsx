"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { FileCode2 } from "lucide-react";
import { SwarmCursor } from "@/components/swarm/swarm-canvas";
import type { RepoPlan } from "@/lib/plan";
import type { SwarmRole } from "@/lib/swarm";
import type { DeepPartial } from "ai";

export type PartialPlan = DeepPartial<RepoPlan>;

const SIZE_STYLES: Record<string, string> = {
	S: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
	M: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
	L: "bg-red-500/15 text-red-700 dark:text-red-300",
};

/**
 * The planner's first pass on a repository, drawn as it streams in: the contracts it read,
 * the invariants it picked, and the issues it queued. Its cursor sits on whatever it wrote
 * last; when the plan is done, the prover and reviewer step up to the first issue.
 */
export function PlanBoard({ repo, plan, status }: { repo: string; plan: PartialPlan | undefined; status: "planning" | "done" }) {
	const frameRef = useRef<HTMLDivElement>(null);
	const cardRefs = useRef(new Map<string, HTMLElement>());
	const [spots, setSpots] = useState<Record<string, { x: number; y: number }>>({});
	const [width, setWidth] = useState(0);

	const contracts = (plan?.contracts ?? []).filter((c) => c?.path);
	const invariants = (plan?.invariants ?? []).filter((i) => i?.statement);
	const issues = (plan?.issues ?? []).filter((i) => i?.title);

	// The planner points at the newest card, whichever column it landed in.
	const latest = issues.length ? `issue-${issues.length - 1}` : invariants.length ? `inv-${invariants.length - 1}` : contracts.length ? `contract-${contracts.length - 1}` : null;
	const plannerSay = status === "done"
		? `Queued ${issues.length} issues. Next: prover`
		: issues.length ? `Queued: ${issues.at(-1)?.title ?? ""}`
		: invariants.length ? "Picking the invariants worth proving"
		: contracts.length ? `Reading ${contracts.at(-1)?.path ?? ""}`
		: `Reading ${repo}`;

	const ref = (key: string) => (el: HTMLElement | null) => {
		if (el) cardRefs.current.set(key, el);
		else cardRefs.current.delete(key);
	};

	useLayoutEffect(() => {
		const frame = frameRef.current;
		if (!frame) return;
		const measure = () => {
			const box = frame.getBoundingClientRect();
			const at = (key: string | null, dx: number, dy: number) => {
				const el = key ? cardRefs.current.get(key) : undefined;
				if (!el) return undefined;
				const r = el.getBoundingClientRect();
				return { x: r.right - box.left + dx, y: r.top - box.top + dy };
			};
			setWidth(box.width);
			setSpots({
				planner: at(latest, -36, 18) ?? { x: 40, y: 64 },
				prover: (status === "done" && at("issue-0", -36, 44)) || { x: box.width - 300, y: box.height - 58 },
				// Lower than the prover on its neighbouring card, so the two labels never share a row.
				reviewer: (status === "done" && at("inv-0", -36, 112)) || { x: box.width - 160, y: box.height - 58 },
			});
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(frame);
		return () => observer.disconnect();
	}, [latest, status, contracts.length, invariants.length, issues.length]);

	const cursor = (role: SwarmRole, say: string | undefined, turn: boolean) => {
		const spot = spots[role];
		if (!spot) return null;
		// The reviewer's bubble opens over its own card, not into the prover's column next to it.
		const left = spot.x > width - 260 || (role === "reviewer" && status === "done");
		return <SwarmCursor key={role} role={role} x={spot.x} y={spot.y} say={say} turn={turn} side={left ? "left" : undefined} />;
	};

	return (
		<div ref={frameRef} className="relative overflow-hidden rounded-2xl border bg-card p-4 pb-20 shadow-sm sm:p-5 sm:pb-20" style={{ backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)", backgroundSize: "20px 20px" }}>
			<p className="max-w-3xl text-sm leading-6 text-muted-foreground">
				<span className="font-mono text-foreground">{repo}</span>
				{plan?.summary ? <> · {plan.summary}</> : " · reading the contracts…"}
			</p>
			<div className="mt-4 grid gap-4 md:grid-cols-3">
				<Column title="Contracts read" count={contracts.length}>
					{contracts.map((c, i) => (
						<li key={i} ref={ref(`contract-${i}`)} className="rounded-lg border bg-background p-3 shadow-sm animate-in fade-in-0 slide-in-from-bottom-1">
							<p className="flex items-center gap-1.5 font-mono text-sm text-muted-foreground"><FileCode2 className="size-3.5 shrink-0" /><span className="truncate">{c?.path}</span></p>
							{c?.role ? <p className="mt-1 text-sm leading-snug">{c.role}</p> : null}
						</li>
					))}
				</Column>
				<Column title="Invariants" count={invariants.length}>
					{invariants.map((inv, i) => (
						<li key={i} ref={ref(`inv-${i}`)} className="rounded-lg border bg-background p-3 shadow-sm animate-in fade-in-0 slide-in-from-bottom-1">
							<p className="text-sm leading-snug">{inv?.statement}</p>
							{inv?.why ? <p className="mt-1 text-sm leading-snug text-muted-foreground">{inv.why}</p> : null}
						</li>
					))}
				</Column>
				<Column title="fm:todo" count={issues.length} mono>
					{issues.map((issue, i) => (
						<li key={i} ref={ref(`issue-${i}`)} className="rounded-lg border bg-background p-3 shadow-sm animate-in fade-in-0 slide-in-from-bottom-1">
							<p className="flex items-center gap-1.5 text-sm text-muted-foreground">
								<span className="font-mono">#{i + 1}</span>
								{issue?.size ? <span className={`rounded px-1.5 py-px font-mono text-sm ${SIZE_STYLES[issue.size]}`}>{issue.size}</span> : null}
							</p>
							<p className="mt-1 text-sm font-medium leading-snug">{issue?.title}</p>
							{issue?.scope ? <p className="mt-1 text-sm leading-snug text-muted-foreground">{issue.scope}</p> : null}
						</li>
					))}
				</Column>
			</div>
			{cursor("planner", plannerSay, status === "planning")}
			{cursor("prover", status === "done" ? `I'll take #1 when you start` : "Waiting for the plan", false)}
			{cursor("reviewer", status === "done" ? "I'll check each proof against these" : undefined, false)}
		</div>
	);
}

function Column({ title, count, mono, children }: { title: string; count: number; mono?: boolean; children: React.ReactNode }) {
	return (
		<section className="min-w-0 rounded-xl border border-dashed bg-muted/40 p-2.5">
			<h3 className={`flex items-center justify-between px-1 pb-2 text-sm font-medium text-muted-foreground ${mono ? "font-mono" : ""}`}>
				{title}
				<span className="tabular-nums">{count}</span>
			</h3>
			<ol className="flex min-h-24 flex-col gap-2">{children}</ol>
		</section>
	);
}
