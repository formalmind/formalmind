import { useEffect, useState } from "react";
import { Link } from "react-router";
import { DEPOSITS_USD } from "@/lib/billing-plans";
import { notify } from "@/lib/notifications";
import type { CreditEntry } from "@/lib/billing";

type Balance = { configured: boolean; cents: number; entries: CreditEntry[]; error?: string };

const usd = (cents: number) => `${cents < 0 ? "−" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

/** A line of history: a deposit, or one swarm run's model calls added up (they are charged call by call). */
type Line = { key: string; at: string; cents: number; label: string; detail?: string; href?: string };

function historyLines(entries: CreditEntry[]): Line[] {
	const runs = new Map<string, Line>();
	const lines: Line[] = [];
	for (const e of entries) {
		if (e.kind === "deposit") {
			lines.push({ key: e.ref, at: e.at, cents: e.cents, label: e.ref.startsWith("adjust:") ? "Credit adjustment" : "Credits added" });
			continue;
		}
		// A spend's ref is <proofs repo>:<Actions run id>:<call>.
		const [repo, run] = e.ref.split(":");
		const key = `${repo}:${run}`;
		const line = runs.get(key);
		if (line) {
			line.cents += e.cents;
			if (e.at > line.at) line.at = e.at;
		} else {
			const entry: Line = { key, at: e.at, cents: e.cents, label: "Swarm run", detail: repo, href: run ? `https://github.com/${repo}/actions/runs/${run}` : undefined };
			runs.set(key, entry);
			lines.push(entry);
		}
	}
	return lines.sort((a, b) => b.at.localeCompare(a.at));
}

/** Prepaid credits: the balance, buying more through Stripe Checkout, and every deposit so far. */
export function BillingPage() {
	const [balance, setBalance] = useState<Balance | null>(null);
	const [paying, setPaying] = useState<number | null>(null);

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
					<p className="mt-1 text-3xl font-semibold tabular-nums">{balance ? usd(balance.cents) : "…"}</p>
					<p className="mt-2 text-xs text-muted-foreground">
						Prepaid model usage for your swarm. It pauses for the day once the daily budget is spent.{" "}
						<Link to="/usage" className="underline underline-offset-2 hover:text-foreground">
							See usage
						</Link>
					</p>
				</section>

				<section className="rounded-xl border p-5">
					<h2 className="text-sm font-medium">Add credits</h2>
					{balance && !balance.configured ? (
						<p className="mt-4 text-sm text-muted-foreground">Payments aren't connected yet.</p>
					) : (
						<div className="mt-4 flex flex-wrap gap-2">
							{DEPOSITS_USD.map((amount) => (
								<button
									key={amount}
									type="button"
									disabled={!balance || paying !== null}
									onClick={() => void buy(amount)}
									className="inline-flex h-9 items-center rounded-full border px-4 text-sm font-medium tabular-nums transition-colors hover:bg-muted disabled:opacity-50"
								>
									{paying === amount ? "Opening checkout…" : `$${amount}`}
								</button>
							))}
						</div>
					)}
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
									<span className="min-w-0 flex-1 truncate">
										{l.label}
										{l.detail ? (
											<>
												{" "}
												{l.href ? (
													<a href={l.href} target="_blank" rel="noreferrer" className="text-muted-foreground hover:text-foreground hover:underline">
														{l.detail}
													</a>
												) : (
													<span className="text-muted-foreground">{l.detail}</span>
												)}
											</>
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
