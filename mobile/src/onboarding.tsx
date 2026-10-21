import { useRef, useState } from "react";

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

/** A screen of the app; only its bottom fades, into the words below it. */
export function Shot({ src, className = "", style }: { src: string; className?: string; style?: React.CSSProperties }) {
	return (
		<img
			src={src}
			alt=""
			draggable={false}
			className={`pointer-events-none select-none rounded-[14px] ${className}`}
			style={{ WebkitMaskImage: "linear-gradient(to bottom, #000 55%, transparent)", maskImage: "linear-gradient(to bottom, #000 55%, transparent)", ...style }}
		/>
	);
}

/** The Mac app's corner, zoomed in on the logo, the rest of its UI fading away around it. */
function MacCorner() {
	return (
		<div className="relative h-[300px] w-[340px] overflow-hidden" style={{ WebkitMaskImage: "radial-gradient(ellipse 48% 44% at 50% 50%, #000 30%, transparent 100%)" }}>
			<img src="/onboarding/mac.jpg" alt="" draggable={false} className="fm-zoom-in pointer-events-none absolute max-w-none select-none" style={{ width: 640, left: 78, top: 80, transformOrigin: "92px 71px" }} />
		</div>
	);
}

const PAGES: Page[] = [
	{
		muted: "Formal Mind,",
		strong: "on your iPhone.",
		body: "Formal Mind proves Solidity correct: it writes your contracts' behaviour as Lean theorems, proves them, and files the bugs it finds, each with a proof of concept.",
		art: <MacCorner />,
	},
	{
		muted: "Every function, against its spec.",
		strong: "See what's proved.",
		body: "Each contract's Lean coverage: which functions are modeled, which are proved, and the theorems that prove them, beside the Solidity.",
		art: <Shot src="/onboarding/mac-proofs.jpg" className="w-[370px]" />,
	},
	{
		muted: "Every finding, with its proof.",
		strong: "See what's broken.",
		body: "The bugs from your audits and from the swarm, with their severity, where they stand in the code today, and the Foundry test that shows them.",
		art: <Shot src="/onboarding/mac-bugs.jpg" className="w-[370px]" />,
	},
	{
		muted: "The swarm works on your Mac.",
		strong: "You steer it from here.",
		body: "Agents prove your functions and hunt bugs on your Mac, where Lean and Foundry run. Follow them, send a message, start or stop, and hear when a proof lands or a bug is filed.",
		art: <Shot src="/onboarding/mac-swarm.jpg" className="w-[370px]" />,
	},
	{
		// The last page has no words: the app's icon, and Home as you'll find it.
		muted: "",
		strong: "",
		body: "",
		art: (
			<div className="flex flex-col items-center gap-6">
				<img src="/onboarding/icon.png" alt="Formal Mind" className="size-[84px] drop-shadow-[0_12px_30px_rgb(0_0_0/0.6)]" />
				<Shot src="/onboarding/home.jpg" className="w-[250px] rounded-[34px]" />
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
	return (
		<main
			className="fm-safe-top fm-safe-bottom relative flex min-h-dvh flex-col bg-[radial-gradient(ellipse_at_top,#151a24_0%,#08090b_60%)] px-6 pb-8 text-white"
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
			<button type="button" onClick={next} className="mt-6 w-full rounded-xl bg-white px-4 py-3 text-[15px] font-medium text-neutral-950 active:bg-neutral-100">
				{last ? "Get started" : "Continue"}
			</button>
		</main>
	);
}
