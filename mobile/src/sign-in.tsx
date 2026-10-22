import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { LogoMark } from "@/components/logo";
import { apiBase, newPollId, pollForToken } from "@/desktop/src/api";

const primary = "w-full rounded-full bg-white px-4 py-3 text-[15px] font-medium text-neutral-950 shadow-[0_0_0_3px_rgba(96,165,250,0.35)] transition active:bg-neutral-100 disabled:opacity-60";

/**
 * Sign in with formal.team, as the Mac app does: Safari opens /api/desktop/authorize, which hands the app a one-time
 * code by the formalmind:// link (handled in ./app.tsx); the app also polls for it, and a pasted code works too.
 */
export function SignIn({ onCode, onSignedIn, error }: { onCode: (code: string) => void; onSignedIn: () => void; error: string | null }) {
	const [waiting, setWaiting] = useState(false);
	const [pasting, setPasting] = useState(false);
	const [code, setCode] = useState("");
	const polling = useRef<AbortController | null>(null);
	useEffect(() => () => polling.current?.abort(), []);
	const start = () => {
		setWaiting(true);
		polling.current?.abort();
		const controller = (polling.current = new AbortController());
		const poll = newPollId();
		void openUrl(`${apiBase()}/api/desktop/authorize?poll=${poll}`);
		void pollForToken(poll, controller.signal).then((ok) => {
			if (ok) onSignedIn();
			else if (!controller.signal.aborted) setWaiting(false);
		});
	};
	return (
		<main className="fm-safe-top fm-safe-bottom relative flex min-h-dvh flex-col justify-end bg-[radial-gradient(ellipse_at_top,#151a24_0%,#08090b_60%)] px-6 pb-10 text-white">
			{/* The F alone, large, in the middle of the space above the words. */}
			<div className="grid flex-1 place-items-center py-10">
				<LogoMark bare shimmer size={132} className="drop-shadow-[0_18px_40px_rgb(0_0_0/0.6)]" />
			</div>
			<h1 className="fm-rise font-display text-[44px] leading-[1.05]">
				<span className="text-white/45">Your proofs and bugs,</span>
				<br />
				in your pocket.
			</h1>
			<p className="mt-4 text-[15px] leading-6 text-white/55">Read your projects&apos; code, proofs and bugs, and steer the swarm working on your Mac.</p>
			<div className="mt-10 space-y-4">
				<button type="button" onClick={start} className={primary}>
					{waiting ? "Waiting for Safari…" : "Continue with GitHub"}
				</button>
				{pasting ? (
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (code.trim()) onCode(code.trim());
						}}
					>
						<input autoFocus value={code} onChange={(e) => setCode(e.target.value)} placeholder="Paste the code" className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none" />
						<button type="submit" className="rounded-xl bg-white/10 px-4 text-sm">Continue</button>
					</form>
				) : (
					<p className="text-center text-sm text-white/50">
						{waiting ? "Finish signing in in Safari. " : null}
						<button type="button" onClick={() => setPasting(true)} className="underline-offset-4 active:underline">
							Have a code?
						</button>
					</p>
				)}
				{error ? <p className="text-sm text-red-400">{error}</p> : null}
			</div>
		</main>
	);
}
