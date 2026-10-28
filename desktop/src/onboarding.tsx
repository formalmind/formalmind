import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { apiBase, DEFAULT_API, newPollId, pollForToken, setApiBase } from "./api";

/** Three small cards: the contract, its proof, the check. Tilted like prints on a table. */
function Cards() {
	const card = "shadow-pop h-28 w-44 shrink-0 overflow-hidden whitespace-nowrap rounded-xl border border-white/10 bg-neutral-900 p-3 text-left font-mono text-[9px] leading-relaxed";
	return (
		<div className="fm-rise flex items-center justify-center gap-4" aria-hidden>
			<div className={`${card} -rotate-6 text-neutral-400`}>
				<span className="text-sky-300">function</span> deposit(
				<br />
				&nbsp;&nbsp;<span className="text-amber-200">uint</span> a) {"{"}
				<br />
				&nbsp;&nbsp;balance[msg.sender] += a;
				<br />
				&nbsp;&nbsp;total += a;
				<br />
				{"}"}
			</div>
			<div className={`${card} text-neutral-400`}>
				<span className="text-violet-300">theorem</span> deposit_adds
				<br />
				&nbsp;&nbsp;(s : Vault) (a : Nat) :
				<br />
				&nbsp;&nbsp;(deposit s a).total
				<br />
				&nbsp;&nbsp;&nbsp;&nbsp;= s.total + a := <span className="text-violet-300">by</span>
				<br />
				&nbsp;&nbsp;simp [deposit]
			</div>
			<div className={`${card} rotate-6 grid place-items-center font-sans`}>
				<div className="text-center">
					<div className="mx-auto grid size-8 place-items-center rounded-full bg-emerald-400/15 text-base text-emerald-300">✓</div>
					<div className="mt-2 text-[11px] text-neutral-300">lake build</div>
					<div className="text-[10px] text-neutral-500">0 sorry · 0 axioms</div>
				</div>
			</div>
		</div>
	);
}

function Dots({ step, total }: { step: number; total: number }) {
	return (
		<div className="absolute inset-x-0 bottom-8 flex justify-center gap-1.5" aria-label={`Step ${step + 1} of ${total}`}>
			{Array.from({ length: total }, (_, i) => (
				<span key={i} className={`h-1.5 rounded-full transition-all duration-300 ${i === step ? "w-6 bg-white" : "w-1.5 bg-white/25"}`} />
			))}
		</div>
	);
}

function Frame({ step, children }: { step: number; children: React.ReactNode }) {
	return (
		<main className="relative grid min-h-screen place-items-center overflow-hidden bg-[radial-gradient(ellipse_at_top,#151a24_0%,#08090b_55%)] px-6 text-white">
			<div data-tauri-drag-region className="fm-drag" />
			<div key={step} className="flex w-full max-w-md flex-col items-center gap-10 text-center">
				{children}
			</div>
			<Dots step={step} total={3} />
		</main>
	);
}

function Headline({ muted, strong }: { muted: string; strong: string }) {
	return (
		<h1 className="fm-rise font-display text-5xl leading-[1.05] [animation-delay:80ms]">
			<span className="text-white/45">{muted}</span>
			<br />
			{strong}
		</h1>
	);
}

const primary = "w-full rounded-xl bg-white px-4 py-3 text-[15px] font-medium text-neutral-950 shadow-[0_0_0_3px_rgba(96,165,250,0.35)] transition hover:bg-neutral-100 disabled:opacity-60";
const quiet = "text-sm text-white/50 underline-offset-4 hover:text-white/80 hover:underline";

function GitHubMark() {
	return (
		<svg viewBox="0 0 16 16" className="size-[18px]" fill="currentColor" aria-hidden>
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
		</svg>
	);
}

/** Step 1: sign in with GitHub in the browser; the app gets a code back by deep link (or pasted). */
export function SignInStep({ onCode, onSignedIn, error }: { onCode: (code: string) => void; onSignedIn: () => void; error: string | null }) {
	const [waiting, setWaiting] = useState(false);
	const [pasting, setPasting] = useState(false);
	const [code, setCode] = useState("");
	const [base, setBase] = useState(apiBase());
	const polling = useRef<AbortController | null>(null);
	useEffect(() => () => polling.current?.abort(), []);
	const start = () => {
		setApiBase(base);
		setWaiting(true);
		// The app asks the server for its sign-in under this id, so it works even when the deep link doesn't.
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
		<Frame step={0}>
			<Cards />
			<Headline muted="Start your first proofs." strong="Let’s get you set up." />
			<div className="fm-rise w-full space-y-4 [animation-delay:160ms]">
				<button type="button" onClick={start} className={`${primary} flex items-center justify-center gap-2.5`}>
					<GitHubMark />
					{waiting ? "Waiting for your browser…" : "Continue with GitHub"}
				</button>
				{!pasting ? (
					<p className="text-sm text-white/50">
						{waiting ? "Finish signing in in your browser. " : null}
						<button type="button" onClick={() => setPasting(true)} className={quiet}>
							Have a code?
						</button>
					</p>
				) : null}
				{pasting ? (
					<form
						className="flex gap-2"
						onSubmit={(e) => {
							e.preventDefault();
							if (code.trim()) onCode(code.trim());
						}}
					>
						<input
							autoFocus
							value={code}
							onChange={(e) => setCode(e.target.value)}
							placeholder="Paste the code from your browser"
							className="min-w-0 flex-1 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
						/>
						<button type="submit" className="rounded-xl bg-white/10 px-4 text-sm hover:bg-white/15">Continue</button>
					</form>
				) : null}
				{error ? <p className="text-sm text-red-400">{error}</p> : null}
				<p className="text-xs text-white/40">
					By continuing, you agree to the{" "}
					<button type="button" onClick={() => void openUrl(`${DEFAULT_API}/terms`)} className="underline underline-offset-2 hover:text-white/70">Terms of Service</button> and{" "}
					<button type="button" onClick={() => void openUrl(`${DEFAULT_API}/privacy`)} className="underline underline-offset-2 hover:text-white/70">Privacy Policy</button>.
				</p>
			</div>
			<details className="absolute bottom-6 right-6 text-left text-xs text-white/35">
				<summary className="cursor-pointer list-none hover:text-white/60">Server</summary>
				<input
					value={base}
					onChange={(e) => setBase(e.target.value)}
					onBlur={() => setApiBase(base)}
					placeholder={DEFAULT_API}
					className="mt-2 w-56 rounded-md border border-white/15 bg-white/5 px-2 py-1 text-white"
				/>
			</details>
		</Frame>
	);
}

/** Step 2: a folder on this computer to prove. */
function FolderStep({ onNext }: { onNext: () => void }) {
	const [error, setError] = useState<string | null>(null);
	const pick = async () => {
		const path = await open({ directory: true, title: "Choose a Solidity project" });
		if (typeof path !== "string") return;
		try {
			await invoke("folder_add", { path });
			window.dispatchEvent(new Event("fm:folders"));
			onNext();
		} catch (e) {
			setError(String(e));
		}
	};
	return (
		<Frame step={1}>
			<Cards />
			<Headline muted="Pick a project." strong="It stays on your Mac." />
			<div className="fm-rise w-full space-y-4 [animation-delay:160ms]">
				<button type="button" onClick={() => void pick()} className={primary}>Choose a folder</button>
				{error ? <p className="text-sm text-red-400">{error}</p> : null}
				<button type="button" onClick={onNext} className={quiet}>Skip for now</button>
			</div>
		</Frame>
	);
}

/** Step 3: how agents reach a model — your Claude plan through Claude Code or your ChatGPT plan through Codex (no key), or your own Anthropic key kept in the keychain. */
function KeyStep({ onNext }: { onNext: () => void }) {
	const [own, setOwn] = useState(false);
	const [key, setKey] = useState("");
	const choose = (provider: "claude-code" | "codex" | "anthropic") => {
		try {
			localStorage.setItem("fm:provider", provider);
		} catch {
			/* the swarm panel asks again */
		}
	};
	return (
		<Frame step={2}>
			<Cards />
			<Headline muted="Agents run on Claude." strong="Pick how to pay for it." />
			<div className="fm-rise w-full space-y-4 [animation-delay:160ms]">
				{own ? (
					<form
						className="space-y-4"
						onSubmit={(e) => {
							e.preventDefault();
							choose("anthropic");
							void invoke("anthropic_key_set", { key }).then(onNext);
						}}
					>
						<input
							type="password"
							autoFocus
							value={key}
							onChange={(e) => setKey(e.target.value)}
							placeholder="Anthropic API key (sk-ant-…)"
							className="w-full rounded-xl border border-white/15 bg-white/5 px-4 py-3 text-sm text-white placeholder:text-white/35 focus:border-white/40 focus:outline-none"
						/>
						<button type="submit" disabled={!key.trim()} className={primary}>Save to keychain</button>
						<button type="button" onClick={() => setOwn(false)} className={quiet}>Use my Claude plan instead</button>
					</form>
				) : (
					<>
						<button type="button" onClick={() => { choose("claude-code"); onNext(); }} className={primary}>Use my Claude plan</button>
						<p className="text-sm text-white/50">
							No key needed: agents run through the Claude Code you're signed in to.{" "}
							<button type="button" onClick={() => setOwn(true)} className={quiet}>Use my own Anthropic key</button>
						</p>
						<p className="text-sm text-white/50">
							On ChatGPT instead?{" "}
							<button type="button" onClick={() => { choose("codex"); onNext(); }} className={quiet}>Use my ChatGPT plan</button> (through the Codex you're signed in to)
						</p>
					</>
				)}
			</div>
		</Frame>
	);
}

const DONE = "fm:onboarded";
export const onboarded = () => {
	try {
		return localStorage.getItem(DONE) === "1";
	} catch {
		return false;
	}
};

/** After sign-in, first launch only: folder, then key. */
export function SetupSteps({ onDone }: { onDone: () => void }) {
	const [step, setStep] = useState(1);
	const finish = () => {
		try {
			localStorage.setItem(DONE, "1");
		} catch {
			/* private storage: the steps show again next launch */
		}
		onDone();
	};
	return step === 1 ? <FolderStep onNext={() => setStep(2)} /> : <KeyStep onNext={finish} />;
}
