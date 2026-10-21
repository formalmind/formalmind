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

/** A screen of the app, its edges fading out so it reads as a glimpse rather than a frame. */
export function Shot({ src, className = "", style }: { src: string; className?: string; style?: React.CSSProperties }) {
	return (
		<img
			src={src}
			alt=""
			draggable={false}
			className={`pointer-events-none select-none rounded-[26px] ${className}`}
			style={{ WebkitMaskImage: "linear-gradient(to bottom, #000 62%, transparent), linear-gradient(to right, transparent, #000 10%, #000 90%, transparent)", WebkitMaskComposite: "source-in", maskComposite: "intersect", ...style }}
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
		muted: "Code, proofs, bugs.",
		strong: "Read them anywhere.",
		body: "Add a GitHub repository and see how much of it is proved, by which theorems, and every finding with its status and PoC. It all runs on the phone, from a copy of the repository.",
		art: (
			<div className="relative h-[320px] w-[330px]">
				<Shot src="/onboarding/proofs.jpg" className="absolute left-0 top-0 w-[200px] -rotate-3 shadow-[0_20px_60px_rgb(0_0_0/0.5)]" />
				<Shot src="/onboarding/bugs.jpg" className="absolute right-0 top-8 w-[200px] rotate-3 shadow-[0_20px_60px_rgb(0_0_0/0.5)]" />
			</div>
		),
	},
	{
		muted: "The swarm works on your Mac.",
		strong: "You steer it from here.",
		body: "Agents prove your functions and hunt bugs on your Mac, where Lean and Foundry run. Follow what they say, send them a message, start or stop a session. Your code stays on the Mac.",
		art: <Shot src="/onboarding/chat.jpg" className="w-[250px]" style={{ maxHeight: 340, objectFit: "cover", objectPosition: "bottom" }} />,
	},
	{
		muted: "A proof lands, a bug is filed.",
		strong: "You hear about it.",
		body: "Notifications tell you when a proof is done, a bug is filed with its PoC, or a session reaches its budget. Choose which in Settings.",
		art: <Shot src="/onboarding/notifications.jpg" className="w-[300px]" />,
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
				<h1 className="fm-rise font-display text-[42px] leading-[1.05] [animation-delay:60ms]">
					<span className="text-white/45">{page.muted}</span>
					<br />
					{page.strong}
				</h1>
				<p className="fm-rise mt-4 text-[15px] leading-6 text-white/60 [animation-delay:120ms]">{page.body}</p>
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
