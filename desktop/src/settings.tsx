import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, CreditCard, Crosshair, FolderSearch, Server, Smartphone, Sparkles, SquareCode, type LucideIcon } from "lucide-react";
import { openOnWeb } from "@/lib/open-web";
import { apiBase, DEFAULT_API, setApiBase } from "./api";
import { setVimMode, useVimMode } from "@/components/vim-mode";
import { AuditFolders, EntryPoints } from "@/components/audit-folders";
import { useFolders } from "./local";
import { relayOn } from "./relay";

type Provider = "formal" | "anthropic" | "openai" | "claude-code";
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

/** One provider's API key: saved in the macOS keychain, or forgotten. */
function ApiKey({ vendor, name, placeholder, onSaved }: { vendor: "anthropic" | "openai"; name: string; placeholder: string; onSaved: () => void }) {
	const [hasKey, setHasKey] = useState(false);
	const [key, setKey] = useState("");
	useEffect(() => void invoke<boolean>(`${vendor}_key_status`).then(setHasKey), [vendor]);
	return (
		<div className="flex items-center justify-between gap-4 border-t pt-3">
			<span>
				<span className="font-medium">{name} API key</span>
				<span className="block text-xs text-muted-foreground">{hasKey ? "Saved in your macOS keychain." : "Not set. Kept in your macOS keychain when you save it."}</span>
			</span>
			{hasKey ? (
				<button type="button" onClick={() => void invoke(`${vendor}_key_set`, { key: "" }).then(() => setHasKey(false))} className="btn-soft h-8 px-3 text-sm">Forget key</button>
			) : (
				<form
					className="flex gap-1.5"
					onSubmit={(e) => {
						e.preventDefault();
						if (!key.trim()) return;
						void invoke(`${vendor}_key_set`, { key }).then(() => {
							setKey("");
							setHasKey(true);
							onSaved();
						});
					}}
				>
					<input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={placeholder} className="h-8 w-56 rounded-lg border bg-transparent px-2 text-sm" />
					<button type="submit" disabled={!key.trim()} className="btn-dark h-8 px-3 text-sm disabled:opacity-50">Save</button>
				</form>
			)}
		</div>
	);
}

/** The page's subsections, in menu order under their group labels. `?section=` picks one, so a reload or a link lands on it. */
const SECTIONS = [
	{ id: "models", title: "Models", icon: Sparkles, group: "This computer" },
	{ id: "editor", title: "Editor", icon: SquareCode, group: "This computer" },
	{ id: "phone", title: "Phone", icon: Smartphone, group: "This computer" },
	{ id: "server", title: "Server", icon: Server, group: "This computer" },
	{ id: "entry-points", title: "Entry points", icon: Crosshair, group: "Projects" },
	{ id: "audit-reports", title: "Audit reports", icon: FolderSearch, group: "Projects" },
] as const satisfies readonly { id: string; title: string; icon: LucideIcon; group: string }[];
const GROUPS = [...new Set(SECTIONS.map((s) => s.group))];
type SectionId = (typeof SECTIONS)[number]["id"];

/** The desktop app's settings: how agents reach a model (and your keys), and which server the app talks to. */
export function SettingsPage() {
	const [provider, setProvider] = useState<Provider>(() => {
		const p = read("fm:provider");
		return p === "anthropic" || p === "openai" || p === "claude-code" ? p : "formal";
	});
	// Claude Code on this computer: its version, or why it can't run (for the hunter on your own Claude plan).
	const [claudeCode, setClaudeCode] = useState<{ ok: boolean; text: string } | null>(null);
	useEffect(() => {
		void invoke<string>("claude_code_status").then((v) => setClaudeCode({ ok: true, text: v }), (e) => setClaudeCode({ ok: false, text: String(e) }));
	}, []);
	const [base, setBase] = useState(apiBase());
	const [saved, setSaved] = useState<string | null>(null);
	const [params, setParams] = useSearchParams();
	const section: SectionId = SECTIONS.find((s) => s.id === params.get("section"))?.id ?? "models";
	const show = (id: SectionId) => setParams({ section: id }, { replace: true });
	const vim = useVimMode();
	const [relay, setRelay] = useState(relayOn);
	const { folders } = useFolders();
	const [repos, setRepos] = useState<Record<string, string>>({});
	useEffect(() => void invoke<{ repos?: Record<string, string> }>("config_get").then((c) => setRepos(c.repos ?? {}), () => {}), []);

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
		<div className="flex w-full flex-1">
			{/* The side panel: the subsections under their group labels, then Billing on formal.team. Its line runs the page's height. */}
			<nav aria-label="Settings sections" className="w-56 shrink-0 border-r">
				<div className="sticky top-0 px-3 py-5">
					{GROUPS.map((group) => (
						<div key={group} className="mb-5">
							<p className="mb-1 px-2.5 text-[12px] text-muted-foreground">{group}</p>
							{SECTIONS.filter((s) => s.group === group).map(({ id, title, icon: Icon }) => (
								<button
									key={id}
									type="button"
									onClick={() => show(id)}
									aria-current={section === id ? "page" : undefined}
									className={`flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] ${section === id ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
								>
									<Icon className="size-4 shrink-0" />
									{title}
								</button>
							))}
						</div>
					))}
					<p className="mb-1 px-2.5 text-[12px] text-muted-foreground">Account</p>
					<button type="button" onClick={() => openOnWeb("/billing")} className="flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground">
						<CreditCard className="size-4 shrink-0" />
						Billing
						<ArrowUpRight className="ml-auto size-3.5" />
					</button>
				</div>
			</nav>
			<div className="min-w-0 flex-1 p-6">
				<div className="mx-auto max-w-3xl space-y-4">
					{section === "models" ? <Section title="Models">
						<label className="flex items-center justify-between gap-4">
							<span>
								<span className="font-medium">Run agents via</span>
								<span className="block text-xs text-muted-foreground">Credits run Claude, metered by formal.team and shown in Billing. Your own key goes straight to Anthropic (Claude) or OpenAI (GPT-5). Claude Code runs the Concolic hunter on your own Claude plan (Max or Pro), with the `claude` you're logged in to.</span>
							</span>
							<select value={provider} onChange={(e) => pick(e.target.value as Provider)} className="h-8 rounded-lg border bg-background px-2 text-sm">
								<option value="formal">formal.team credits</option>
								<option value="anthropic">My Anthropic key</option>
								<option value="openai">My OpenAI key</option>
								<option value="claude-code" disabled={claudeCode?.ok === false}>Claude Code (my Claude plan)</option>
							</select>
						</label>
						{claudeCode ? (
							<p className={`text-xs ${claudeCode.ok ? "text-muted-foreground" : "text-amber-600"}`}>
								{claudeCode.ok ? `Claude Code ${claudeCode.text} is installed. With it picked, the Concolic hunter runs on it; the formal agents need credits or a key.` : claudeCode.text}
							</p>
						) : null}
						<ApiKey vendor="anthropic" name="Anthropic" placeholder="sk-ant-…" onSaved={() => flash("Key saved")} />
						<ApiKey vendor="openai" name="OpenAI" placeholder="sk-…" onSaved={() => flash("Key saved")} />
					</Section> : null}
					{section === "entry-points" ? <Section title="Entry points">
						<p className="text-xs text-muted-foreground">The contracts Proofs models for each folder; the first opens by default. Picking a contract on the Proofs page makes it the first.</p>
						{folders.map((f) => (
							<EntryPoints key={f} folder={f} />
						))}
						{Object.entries(repos)
							.filter(([, path]) => !folders.includes(path))
							.map(([repo, path]) => (
								<EntryPoints key={path} folder={path} label={repo} />
							))}
					</Section> : null}
					{section === "editor" ? <Section title="Editor">
						<label className="flex items-center justify-between gap-4">
							<span>
								<span className="font-medium">Vim mode</span>
								<span className="block text-xs text-muted-foreground">The Code tab runs Neovim (bundled with the app), with your own config from ~/.config/nvim if you have one.</span>
							</span>
							<input type="checkbox" checked={vim} onChange={(e) => setVimMode(e.target.checked)} className="size-4" />
						</label>
					</Section> : null}
					{section === "audit-reports" ? <Section title="Audit reports">
						<p className="text-xs text-muted-foreground">Where each project's audit reports are read from for Bugs, relative to the project.</p>
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
					</Section> : null}
					{section === "phone" ? <Section title="Phone">
						<label className="flex items-center justify-between gap-4">
							<span>
								<span className="font-medium">Follow and steer the swarm from your phone</span>
								<span className="block text-xs text-muted-foreground">
									The swarm keeps running here. What its agents say goes to your formal.team account as it happens, and messages, Start
									and Stop from Formal Mind on your iPhone come back to this Mac. Your code stays here.
								</span>
							</span>
							<input
								type="checkbox"
								checked={relay}
								onChange={(e) => {
									setRelay(e.target.checked);
									try {
										localStorage.setItem("fm:relay", e.target.checked ? "1" : "0");
									} catch {
										/* kept for this window only */
									}
									window.dispatchEvent(new Event("fm:relay"));
								}}
								className="size-4"
							/>
						</label>
					</Section> : null}
					{section === "server" ? <Section title="Server">
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
					</Section> : null}
					{saved ? <p className="text-sm text-emerald-600">{saved}</p> : null}
				</div>
			</div>
		</div>
	);
}
