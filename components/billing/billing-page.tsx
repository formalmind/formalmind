import { useEffect, useState } from "react";
import { Link } from "react-router";
import { DEPOSITS_USD } from "@/lib/billing-plans";
import { notify } from "@/lib/notifications";
import type { CreditEntry, TokenCounts } from "@/lib/billing";

type Balance = { configured: boolean; cents: number; entries: CreditEntry[]; error?: string };

const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/**
 * A line of history: a deposit (linked to its Stripe payment), or one agent's job in one swarm run with its model calls
 * added up (they are charged call by call). Every spend traces to the agent, its issue or PR, and the Actions run.
 */
type Line = {
	key: string; at: string; cents: number; label: string;
	item?: { text: string; href: string }; repo?: string; run?: { text: string; href: string }; href?: string;
	calls?: number; tokens?: TokenCounts;
};
/** 1234567 → "1.2M". */
const compact = (n: number) => Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);

/** The ledger and the proxy name jobs by what they do; show the agent that does it. */
const AGENTS: Record<string, string> = { plan: "Planner", prove: "Prover", review: "Reviewer", merge: "Merger", chief: "Chief", answer: "Assistant", assist: "Assistant", rebuild: "Rebuilder", edit: "Editor", poc: "PoC writer" };

function historyLines(entries: CreditEntry[]): Line[] {
	const jobs = new Map<string, Line>();
	const lines: Line[] = [];
	for (const e of entries) {
		if (e.kind === "deposit") {
			const stripe = e.ref.startsWith("cs_") ? `https://dashboard.stripe.com/${e.ref.startsWith("cs_test_") ? "test/" : ""}search?query=${e.ref}` : undefined;
			lines.push({ key: e.ref, at: e.at, cents: e.cents, label: e.ref.startsWith("adjust:") ? "Credit adjustment" : "Credits added", href: stripe });
			continue;
		}
		// A spend's ref is <proofs repo>:<run>[:<job>:<issue or PR>]:<call>.
		const [repo, run, role = "", ref = ""] = e.ref.split(":");
		const key = `${repo}:${run}:${role}:${ref}`;
		const local = repo.startsWith("local/");
		let line = jobs.get(key);
		if (!line) {
			line = {
				key, at: e.at, cents: 0, repo,
				label: AGENTS[role] ?? (role ? role[0].toUpperCase() + role.slice(1) : "Swarm run"),
				item: ref ? { text: local ? ref : `#${ref}`, href: local ? "" : `https://github.com/${repo}/issues/${ref}` } : undefined,
				run: run && !local ? { text: "run", href: `https://github.com/${repo}/actions/runs/${run}` } : undefined,
			};
			jobs.set(key, line);
			lines.push(line);
		}
		line.cents += e.cents;
		if (e.at > line.at) line.at = e.at;
		line.calls = (line.calls ?? 0) + 1;
		if (e.tokens) {
			const t = (line.tokens ??= { in: 0, out: 0, read: 0, write: 0 });
			t.in += e.tokens.in;
			t.out += e.tokens.out;
			t.read += e.tokens.read;
			t.write += e.tokens.write;
		}
	}
	return lines.sort((a, b) => b.at.localeCompare(a.at));
}

/** Prepaid credits: the balance, buying more through Stripe Checkout, and every deposit so far. */
export function BillingPage() {
	const [balance, setBalance] = useState<Balance | null>(null);
	const [paying, setPaying] = useState<number | null>(null);
	const [custom, setCustom] = useState("");
	const payable = Boolean(balance?.configured);

	// Back from Stripe Checkout: confirm the payment first, then show the balance.
	useEffect(() => {
		const params = new URLSearchParams(window.location.search);
		const outcome = params.get("checkout");
		const sessionId = params.get("session_id");
		void fetch(`/api/billing/balance${outcome === "success" && sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ""}`)
			.then((r) => r.json())
			.then((body: Balance) => {
				setBalance(body);
				if (body.error) notify.error("Could not load your credits", { description: body.error });
			})
			.catch(() => setBalance({ configured: false, cents: 0, entries: [], error: "Couldn't load your credits." }));
		if (outcome) {
			if (outcome === "success") notify.success("Payment received", { description: "Your credits are topped up. Thanks!" });
			else notify.info("Checkout cancelled", { description: "Nothing was charged." });
			window.history.replaceState(null, "", "/billing");
		}
	}, []);

	const buy = async (amount: number) => {
		setPaying(amount);
		try {
			const res = await fetch("/api/billing/checkout", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ usd: amount, returnTo: "/billing" }),
			});
			const body = (await res.json()) as { url?: string; error?: string };
			if (!res.ok || !body.url) throw new Error(body.error ?? "Checkout failed.");
			window.location.href = body.url;
		} catch (err) {
			notify.error("Checkout failed", { description: err instanceof Error ? err.message : undefined });
			setPaying(null);
		}
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<main className="mx-auto w-full max-w-4xl space-y-6 px-6 pb-10 pt-2">
				<section className="rounded-xl border p-5">
					<p className="text-sm text-muted-foreground">Credit balance</p>
					<p className="mt-1 font-display text-[40px] font-normal leading-tight tabular-nums">{balance ? usd(balance.cents) : "…"}</p>
					<p className="mt-2 text-xs text-muted-foreground">
						Prepaid model usage for your swarm. It pauses for the day once the daily budget is spent.{" "}
						<Link to="/usage" className="underline underline-offset-2 hover:text-foreground">
							See usage
						</Link>
					</p>
				</section>

				<section className="rounded-xl border p-5">
					<h2 className="text-sm font-medium">Add credits</h2>
					<p className="mt-1 text-xs text-muted-foreground">Pick an amount, or enter your own between $10 and $1,000.</p>
					<form
						className="mt-4 flex flex-wrap items-center gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							const n = Number(custom);
							if (n >= 10 && n <= 1000) void buy(n);
						}}
					>
						{DEPOSITS_USD.map((amount) => (
							<button
								key={amount}
								type="button"
								disabled={!payable || paying !== null}
								onClick={() => void buy(amount)}
								className="inline-flex h-9 items-center rounded-full border px-4 text-sm font-medium tabular-nums transition-colors hover:bg-muted disabled:opacity-50"
							>
								{paying === amount ? "Opening checkout…" : `$${amount}`}
							</button>
						))}
						<label className="inline-flex h-9 items-center rounded-full border pl-4 text-sm focus-within:ring-2 focus-within:ring-ring">
							<span className="text-muted-foreground">$</span>
							<input
								type="number"
								inputMode="decimal"
								min={10}
								max={1000}
								step={1}
								value={custom}
								onChange={(e) => setCustom(e.target.value)}
								placeholder="Other"
								aria-label="Other amount in dollars"
								className="w-20 bg-transparent px-1 tabular-nums outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
							/>
							<button
								type="submit"
								disabled={!payable || paying !== null || !(Number(custom) >= 10 && Number(custom) <= 1000)}
								className="h-9 rounded-r-full border-l px-4 font-medium transition-colors hover:bg-muted disabled:opacity-50"
							>
								{paying !== null && paying === Number(custom) ? "Opening…" : "Add"}
							</button>
						</label>
					</form>
					{balance && !balance.configured ? <p className="mt-3 text-xs text-amber-700 dark:text-amber-400">Payments aren't connected on this server yet, so checkout is off here.</p> : null}
					<p className="mt-4 text-xs text-muted-foreground">Paid securely with Stripe.</p>
				</section>

				<section className="rounded-xl border">
					<h2 className="border-b px-5 py-3 text-sm font-medium">History</h2>
					{!balance?.entries.length ? (
						<p className="px-5 py-4 text-sm text-muted-foreground">{balance ? "No payments yet." : "Loading…"}</p>
					) : (
						<ul className="divide-y text-sm">
							{historyLines(balance.entries).map((l) => (
								<li key={l.key} className="flex items-center gap-4 px-5 py-2.5">
									<span className="w-32 shrink-0 text-xs text-muted-foreground tabular-nums">{new Date(l.at).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" })}</span>
									<span className="min-w-0 flex-1">
										<span className="flex items-center gap-1.5 truncate">
											{l.href ? (
												<a href={l.href} target="_blank" rel="noreferrer" className="hover:underline">{l.label}</a>
											) : (
												<span className="font-medium">{l.label}</span>
											)}
											{l.item && !l.item.href ? <span className="text-muted-foreground">{l.item.text}</span> : null}
											{l.item?.href ? <a href={l.item.href} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground hover:underline">{l.item.text}</a> : null}
											{l.repo?.startsWith("local/") ? <span className="truncate text-muted-foreground">{l.repo.slice(6)} (on your computer)</span> : null}
											{l.repo && !l.repo.startsWith("local/") ? <a href={`https://github.com/${l.repo}`} target="_blank" rel="noreferrer" className="truncate text-muted-foreground hover:text-foreground hover:underline">{l.repo}</a> : null}
											{l.run ? <a href={l.run.href} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">{l.run.text} ↗</a> : null}
										</span>
										{l.tokens ? (
											<span
												className="block text-xs text-muted-foreground"
												title={`input ${l.tokens.in.toLocaleString()} · output ${l.tokens.out.toLocaleString()} · cache read ${l.tokens.read.toLocaleString()} · cache write ${l.tokens.write.toLocaleString()}`}
											>
												{l.calls} model calls · {compact(l.tokens.in + l.tokens.out + l.tokens.read + l.tokens.write)} tokens ({compact(l.tokens.out)} out, {compact(l.tokens.read)} cached)
											</span>
										) : l.calls && l.calls > 1 ? (
											<span className="block text-xs text-muted-foreground">{l.calls} model calls</span>
										) : null}
									</span>
									<span className={`font-mono tabular-nums ${l.cents > 0 ? "text-emerald-600 dark:text-emerald-400" : ""}`}>{l.cents > 0 ? "+" : ""}{usd(l.cents)}</span>
								</li>
							))}
						</ul>
					)}
				</section>
			</main>
		</div>
	);
}
