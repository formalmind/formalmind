import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { apiBase, DEFAULT_API, setApiBase } from "./api";
import { setVimMode, useVimMode } from "@/components/vim-mode";
import { AuditFolders } from "@/components/audit-folders";
import { useFolders } from "./local";

type Provider = "formal" | "anthropic";
const read = (k: string) => {
	try {
		return localStorage.getItem(k);
	} catch {
		return null;
	}
};

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
	<section className="rounded-2xl border bg-muted/60 p-1.5">
		<h2 className="flex h-8 items-center px-2.5 font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{title}</h2>
		<div className="shadow-card space-y-3 rounded-xl border bg-card p-4 text-sm">{children}</div>
	</section>
);

/** The desktop app's settings: how agents reach Claude (and your key), and which server the app talks to. */
export function SettingsPage() {
	const [provider, setProvider] = useState<Provider>(read("fm:provider") === "anthropic" ? "anthropic" : "formal");
	const [hasKey, setHasKey] = useState(false);
	const [key, setKey] = useState("");
	const [base, setBase] = useState(apiBase());
	const [saved, setSaved] = useState<string | null>(null);
	const vim = useVimMode();
	const { folders } = useFolders();
	const [repos, setRepos] = useState<Record<string, string>>({});
	useEffect(() => void invoke<{ repos?: Record<string, string> }>("config_get").then((c) => setRepos(c.repos ?? {}), () => {}), []);
	useEffect(() => void invoke<boolean>("anthropic_key_status").then(setHasKey), []);

	const pick = (p: Provider) => {
		setProvider(p);
		try {
			localStorage.setItem("fm:provider", p);
		} catch {
			/* kept for this window only */
		}
	};
	const flash = (what: string) => {
		setSaved(what);
		setTimeout(() => setSaved(null), 2000);
	};

	return (
		<div className="mx-auto w-full max-w-2xl space-y-4 p-6">
			<h1 className="text-xl font-semibold">Settings</h1>
			<Section title="Models">
				<label className="flex items-center justify-between gap-4">
					<span>
						<span className="font-medium">Run agents on Claude via</span>
						<span className="block text-xs text-muted-foreground">Credits are metered by formal.team and shown in Billing. Your own key goes straight to Anthropic.</span>
					</span>
					<select value={provider} onChange={(e) => pick(e.target.value as Provider)} className="h-8 rounded-lg border bg-background px-2 text-sm">
						<option value="formal">formal.team credits</option>
						<option value="anthropic">My Anthropic key</option>
					</select>
				</label>
				<div className="flex items-center justify-between gap-4 border-t pt-3">
					<span>
						<span className="font-medium">Anthropic API key</span>
						<span className="block text-xs text-muted-foreground">{hasKey ? "Saved in your macOS keychain." : "Not set. Kept in your macOS keychain when you save it."}</span>
					</span>
					{hasKey ? (
						<button type="button" onClick={() => void invoke("anthropic_key_set", { key: "" }).then(() => setHasKey(false))} className="btn-soft h-8 px-3 text-sm">Forget key</button>
					) : (
						<form
							className="flex gap-1.5"
							onSubmit={(e) => {
								e.preventDefault();
								if (!key.trim()) return;
								void invoke("anthropic_key_set", { key }).then(() => {
									setKey("");
									setHasKey(true);
									flash("Key saved");
								});
							}}
						>
							<input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" className="h-8 w-56 rounded-lg border bg-transparent px-2 text-sm" />
							<button type="submit" disabled={!key.trim()} className="btn-dark h-8 px-3 text-sm disabled:opacity-50">Save</button>
						</form>
					)}
				</div>
			</Section>
			<Section title="Editor">
				<label className="flex items-center justify-between gap-4">
					<span>
						<span className="font-medium">Vim mode</span>
						<span className="block text-xs text-muted-foreground">The Code tab runs Neovim (bundled with the app), with your own config from ~/.config/nvim if you have one.</span>
					</span>
					<input type="checkbox" checked={vim} onChange={(e) => setVimMode(e.target.checked)} className="size-4" />
				</label>
			</Section>
			<Section title="Audit folders">
				<p className="text-xs text-muted-foreground">Where each project's audit reports are read from for Bugs, relative to the project. Separate several with commas.</p>
				{folders.length + Object.keys(repos).length === 0 ? <p className="text-xs text-muted-foreground">Add a folder or import a repository in the sidebar first.</p> : null}
				{folders.map((f) => (
					<AuditFolders key={f} folder={f} />
				))}
				{/* Imported repositories, by the folder they are cloned (or mapped) to on this machine. */}
				{Object.entries(repos)
					.filter(([, path]) => !folders.includes(path))
					.map(([repo, path]) => (
						<AuditFolders key={path} folder={path} label={repo} />
					))}
			</Section>
			<Section title="Server">
				<label className="flex items-center justify-between gap-4">
					<span>
						<span className="font-medium">formal.team address</span>
						<span className="block text-xs text-muted-foreground">Change only for development, e.g. http://localhost:8787. Sign in again after changing it.</span>
					</span>
					<input
						value={base}
						onChange={(e) => setBase(e.target.value)}
						onBlur={() => {
							setApiBase(base);
							flash("Server saved");
						}}
						placeholder={DEFAULT_API}
						className="h-8 w-64 rounded-lg border bg-transparent px-2 text-sm"
					/>
				</label>
			</Section>
			{saved ? <p className="text-sm text-emerald-600">{saved}</p> : null}
		</div>
	);
}
