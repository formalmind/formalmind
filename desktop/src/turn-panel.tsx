import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

type TurnEvent = { run: string; kind: "text" | "tool" | "result" | "done"; text: string; tokens: number };

/** The user's OpenAI key, kept in the OS keychain. Turns on this machine use it; formal.team never sees it. */
function ModelKey({ onSaved }: { onSaved: () => void }) {
	const [key, setKey] = useState("");
	return (
		<form
			className="flex gap-2"
			onSubmit={(e) => {
				e.preventDefault();
				void invoke("model_key_set", { key }).then(onSaved);
			}}
		>
			<input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="OpenAI API key" className="min-w-0 flex-1 rounded-full border bg-transparent px-3 py-1.5 text-sm" />
			<button type="submit" disabled={!key.trim()} className="btn-dark rounded-full px-3 py-1.5 text-sm">Save</button>
		</form>
	);
}

/** Runs one agent turn on this folder, on this computer, and shows what it does as it goes. */
export function TurnPanel({ folder }: { folder: string }) {
	const [hasKey, setHasKey] = useState<boolean | null>(null);
	const [role, setRole] = useState("prover");
	const [task, setTask] = useState("");
	const [run, setRun] = useState<string | null>(null);
	const [events, setEvents] = useState<TurnEvent[]>([]);
	const [error, setError] = useState<string | null>(null);
	const runRef = useRef<string | null>(null);
	const log = useRef<HTMLOListElement>(null);

	useEffect(() => void invoke<boolean>("model_key_status").then(setHasKey), []);
	useEffect(() => {
		const off = listen<TurnEvent>("turn", ({ payload }) => {
			if (payload.run !== runRef.current) return;
			setEvents((all) => [...all, payload]);
			if (payload.kind === "done") setRun(null);
		});
		return () => void off.then((f) => f());
	}, []);
	useEffect(() => log.current?.lastElementChild?.scrollIntoView({ block: "nearest" }), [events]);

	const start = async () => {
		setError(null);
		setEvents([]);
		try {
			const id = await invoke<string>("turn_start", { request: { folder, role, task } });
			runRef.current = id;
			setRun(id);
		} catch (e) {
			setError(String(e));
		}
	};

	const tokens = events.at(-1)?.tokens ?? 0;
	return (
		<section className="shadow-card space-y-3 rounded-xl bg-card p-4">
			<div className="flex items-center justify-between">
				<h2 className="text-sm font-medium">Run a turn here</h2>
				{hasKey ? (
					<button type="button" onClick={() => void invoke("model_key_set", { key: "" }).then(() => setHasKey(false))} className="text-xs text-muted-foreground hover:underline">
						Remove key
					</button>
				) : null}
			</div>
			{hasKey === false ? (
				<>
					<p className="text-sm text-muted-foreground">Turns here use your own OpenAI key. It stays in your keychain.</p>
					<ModelKey onSaved={() => setHasKey(true)} />
				</>
			) : hasKey ? (
				<>
					<div className="flex gap-2">
						<select value={role} onChange={(e) => setRole(e.target.value)} disabled={Boolean(run)} className="rounded-full border bg-transparent px-3 py-1.5 text-sm">
							<option value="prover">Prover</option>
							<option value="reviewer">Reviewer</option>
						</select>
						<input
							value={task}
							onChange={(e) => setTask(e.target.value)}
							disabled={Boolean(run)}
							placeholder={role === "prover" ? "What to prove" : "What to review"}
							className="min-w-0 flex-1 rounded-full border bg-transparent px-3 py-1.5 text-sm"
						/>
						{run ? (
							<button type="button" onClick={() => void invoke("turn_stop", { run })} className="btn-soft rounded-full px-3 py-1.5 text-sm">Stop</button>
						) : (
							<button type="button" onClick={() => void start()} disabled={!task.trim()} className="btn-dark rounded-full px-3 py-1.5 text-sm">Run</button>
						)}
					</div>
					{error ? <p className="text-sm text-red-600">{error}</p> : null}
					{events.length ? (
						<ol ref={log} className="max-h-[50vh] space-y-1.5 overflow-auto font-mono text-xs">
							{events.map((e, i) => (
								<li
									key={i}
									className={
										e.kind === "tool" ? "text-foreground" : e.kind === "result" ? "whitespace-pre-wrap pl-3 text-muted-foreground" : e.kind === "done" ? "font-medium" : "whitespace-pre-wrap font-sans text-sm"
									}
								>
									{e.kind === "tool" ? `› ${e.text}` : e.kind === "done" ? `Turn ${e.text} · ${e.tokens.toLocaleString()} tokens` : e.text}
								</li>
							))}
						</ol>
					) : null}
					{run ? <p className="text-xs text-muted-foreground">Working… {tokens.toLocaleString()} tokens so far</p> : null}
				</>
			) : null}
		</section>
	);
}
