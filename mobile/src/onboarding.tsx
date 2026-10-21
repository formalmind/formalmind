import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { HomeEmpty } from "@/components/home-empty";
import { fnStatus, type Formal } from "@/desktop/src/swarm-panel";
import { FindingCard } from "./bugs";
import { MacCardView } from "./home";
import { CoverageCard, FnCard } from "./proofs";
import formal from "./fixtures/formal-asyncswap.json";

const KEY = "fm:mobile-intro";

/** Whether the introduction was seen (it shows once, before sign-in; Settings can show it again). */
export const introduced = () => {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return true;
	}
};

export const setIntroduced = (on: boolean) => {
	try {
		if (on) localStorage.setItem(KEY, "1");
		else localStorage.removeItem(KEY);
	} catch {
		/* shown again next launch */
	}
};

type Page = { muted: string; strong: string; body: string; art: React.ReactNode };

/* The pages show the app itself: real screens (public/onboarding), their edges fading into the page. */



/** One of the app's own cards, centered, in the app's dark colours whatever the phone's theme. */
function Piece({ children }: { children: React.ReactNode }) {
	return <div className="dark pointer-events-none mx-auto w-full max-w-[320px] select-none text-foreground drop-shadow-[0_24px_50px_rgb(0_0_0/0.5)]">{children}</div>;
}

const data = formal as unknown as Formal;
/** A proved entry point from formal-ast's real output for AsyncSwap (./fixtures). */
const provedFn = data.functions.find((f) => f.entry && fnStatus(f, data.theorems).key === "proved" && f.solidity.split("\n").length > 3) ?? data.functions[0];

const PAGES: Page[] = [
	{
		muted: "Formal Mind,",
		strong: "on your iPhone.",
		body: "Formal Mind proves Solidity correct: it writes your contracts' behaviour as Lean theorems, proves them, and files the bugs it finds, each with a proof of concept.",
		art: (
			<Piece>
				<CoverageCard contract="AsyncSwap" theorems={876} proved={95} notYet={33} opaque={15} />
			</Piece>
		),
	},
	{
		muted: "Every function, against its spec.",
		strong: "See what's proved.",
		body: "Each contract's Lean coverage: which functions are modeled, which are proved, and the theorems that prove them, beside the Solidity.",
		art: (
			<Piece>
				<FnCard f={provedFn} theorems={data.theorems} onOpen={() => {}} className="w-full" />
			</Piece>
		),
	},
	{
		muted: "Every finding, with its proof.",
		strong: "See what's broken.",
		body: "The bugs from your audits and from the swarm, with their severity, where they stand in the code today, and the Foundry test that shows them.",
		art: (
			<Piece>
				<FindingCard
					f={{ report: "lee-audit.md", id: "C-01", severity: "Critical", title: "Native escrow commingled in hook balance, so a self-owned native-output order drains it", status: "fixed", statusText: "Fixed", evidence: "", tests: [], index: "" }}
					onOpen={() => {}}
					className="w-full"
				/>
			</Piece>
		),
	},
	{
		muted: "The swarm works on your Mac.",
		strong: "You steer it from here.",
		body: "Agents prove your functions and hunt bugs on your Mac, where Lean and Foundry run. Follow them, send a message, start or stop, and hear when a proof lands or a bug is filed.",
		art: (
			<Piece>
				<MacCardView status="Online" title="1 session running" hint="Follow and steer it from here" />
			</Piece>
		),
	},
	{
		// The last page has no words: the app's icon, and Home as you'll find it.
		muted: "",
		strong: "",
		body: "",
		art: (
			<div className="flex w-full flex-col items-center gap-6">
				<img src="/onboarding/icon.png" alt="Formal Mind" className="size-[84px] drop-shadow-[0_12px_30px_rgb(0_0_0/0.6)]" />
				{/* Home's empty state itself, its headline cycling through the agents, proofs, bugs and code. */}
				<div className="dark fm-home pointer-events-none w-full max-w-[320px] select-none rounded-[28px] border border-white/10 bg-background text-foreground shadow-[0_24px_60px_rgb(0_0_0/0.5)]">
					<HomeEmpty muted="Bugs, proofs and code." strong="Pick a project.">
						<span className="btn-soft inline-flex h-10 w-full items-center justify-center gap-1.5 text-[14px] font-medium">
							<Plus className="size-4" /> Add a project
						</span>
					</HomeEmpty>
				</div>
			</div>
		),
	},
];

/** The introduction: what Formal Mind is and what the phone does, a page at a time (swipe or Continue). */
export function Onboarding({ onDone }: { onDone: () => void }) {
	const [i, setI] = useState(0);
	const start = useRef<number | null>(null);
	const last = i === PAGES.length - 1;
	const next = () => (last ? onDone() : setI(i + 1));
	const page = PAGES[i];
	// Each page starts in place, whatever the last one scrolled.
	useEffect(() => window.scrollTo(0, 0), [i]);
	return (
		<main
			className="fm-safe-top fm-safe-bottom relative flex min-h-dvh flex-col overflow-x-hidden bg-[radial-gradient(ellipse_at_top,#151a24_0%,#08090b_60%)] px-6 pb-8 text-white"
			onTouchStart={(e) => (start.current = e.touches[0].clientX)}
			onTouchEnd={(e) => {
				const dx = e.changedTouches[0].clientX - (start.current ?? e.changedTouches[0].clientX);
				if (dx < -50 && !last) setI(i + 1);
				if (dx > 50 && i > 0) setI(i - 1);
			}}
		>
			<div className="flex h-12 items-center justify-end">
				{!last ? (
					<button type="button" onClick={onDone} className="px-2 text-[15px] text-white/50">
						Skip
					</button>
				) : null}
			</div>
			<div key={i} className="flex flex-1 flex-col justify-end">
				<div className="fm-rise mb-auto grid flex-1 place-items-center text-white/80">{page.art}</div>
				{page.strong ? (
					<>
						<h1 className="fm-rise font-display text-[42px] leading-[1.05] [animation-delay:60ms]">
							<span className="text-white/45">{page.muted}</span>
							<br />
							{page.strong}
						</h1>
						<p className="fm-rise mt-4 text-[15px] leading-6 text-white/60 [animation-delay:120ms]">{page.body}</p>
					</>
				) : null}
			</div>
			<div className="mt-8 flex justify-center gap-1.5" aria-label={`Page ${i + 1} of ${PAGES.length}`}>
				{PAGES.map((_, n) => (
					<button key={n} type="button" onClick={() => setI(n)} aria-label={`Page ${n + 1}`} className={`h-1.5 rounded-full transition-all duration-300 ${n === i ? "w-6 bg-white" : "w-1.5 bg-white/25"}`} />
				))}
			</div>
			<button type="button" onClick={next} className="mt-6 w-full rounded-full bg-white px-4 py-3 text-[15px] font-medium text-neutral-950 active:bg-neutral-100">
				{last ? "Get started" : "Continue"}
			</button>
		</main>
	);
}
