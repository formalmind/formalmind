import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { invoke } from "@tauri-apps/api/core";
import { ArrowUpRight, Cable, Crosshair, FolderSearch, Puzzle, Server, Sparkles, SquareCode, type LucideIcon } from "lucide-react";
import { Skills } from "./skills-section";
import { apiBase, DEFAULT_API, setApiBase } from "./api";
import { setVimMode, useVimMode } from "@/components/vim-mode";
import { AuditFolders, EntryPoints } from "@/components/audit-folders";
import { useFolders } from "./local";
import { relayOn } from "./relay";

type Provider = "formal" | "anthropic" | "openai" | "claude-code" | "codex";
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
	{ id: "remote", title: "Remote control (MCP)", icon: Cable, group: "This computer" },
	{ id: "github", title: "GitHub", icon: ArrowUpRight, group: "This computer" },
	{ id: "server", title: "Server", icon: Server, group: "This computer" },
	{ id: "skills", title: "Skills", icon: Puzzle, group: "This computer" },
	{ id: "entry-points", title: "Entry points", icon: Crosshair, group: "Projects" },
	{ id: "audit-reports", title: "Audit reports", icon: FolderSearch, group: "Projects" },
] as const satisfies readonly { id: string; title: string; icon: LucideIcon; group: string }[];
const GROUPS = [...new Set(SECTIONS.map((s) => s.group))];
type SectionId = (typeof SECTIONS)[number]["id"];

/** The desktop app's settings: how agents reach a model (and your keys), and which server the app talks to. */
export function SettingsPage() {
	const [provider, setProvider] = useState<Provider>(() => {
		const p = read("fm:provider");
		// Claude Code (your Claude plan) unless you picked a key. ("formal", formal.team's metered route, is still accepted but no longer offered.)
		return p === "anthropic" || p === "openai" || p === "codex" || p === "formal" ? p : "claude-code";
	});
	// Claude Code on this computer: its version and plan, or why it can't run the agents on your own Claude plan.
	const [claudeCode, setClaudeCode] = useState<{ ok: boolean; text: string } | null>(null);
	// Codex on this computer, the same for your ChatGPT plan.
	const [codex, setCodex] = useState<{ ok: boolean; text: string } | null>(null);
	useEffect(() => {
		void invoke<string>("claude_code_status").then((v) => setClaudeCode({ ok: true, text: v }), (e) => setClaudeCode({ ok: false, text: String(e) }));
		void invoke<string>("codex_status").then((v) => setCodex({ ok: true, text: v }), (e) => setCodex({ ok: false, text: String(e) }));
	}, []);
	const [base, setBase] = useState(apiBase());
	const [saved, setSaved] = useState<string | null>(null);
	const [params, setParams] = useSearchParams();
	const section: SectionId = SECTIONS.find((s) => s.id === params.get("section"))?.id ?? "models";
	const show = (id: SectionId) => setParams({ section: id }, { replace: true });
	const vim = useVimMode();
	const [relay, setRelay] = useState(relayOn);
	const { folders } = useFolders();
	// Each folder's Report to GitHub, as the backend keeps it (off unless turned on).
	const [github, setGithub] = useState<Record<string, boolean>>({});
	const [answers, setAnswers] = useState<"mcp" | "agent">("mcp");
	useEffect(() => void invoke<{ github?: Record<string, boolean>; answers?: string }>("settings_get").then((s) => {
		setGithub(s.github ?? {});
		setAnswers(s.answers === "agent" ? "agent" : "mcp");
	}, () => {}), []);
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
			{/* The side panel: the subsections under their group labels. Its line runs the page's height. */}
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
				</div>
			</nav>
			<div className="min-w-0 flex-1 p-6">
				<div className="mx-auto max-w-3xl space-y-4">
					{section === "models" ? <Section title="Models">
						<label className="flex items-center justify-between gap-4">
							<span>
								<span className="font-medium">Run agents via</span>
								<span className="block text-xs text-muted-foreground">Claude Code runs every agent on your own Claude plan (Max or Pro), through the `claude` you're signed in to; Codex does the same on your ChatGPT plan (Pro or Plus), through the `codex` you're signed in to. Nothing is charged to a key, and your plan's usage limits apply. Your own key goes straight to Anthropic (Claude) or OpenAI (GPT-5).</span>
							</span>
							<select value={provider} onChange={(e) => pick(e.target.value as Provider)} className="h-8 rounded-lg border bg-background px-2 text-sm">
								<option value="claude-code" disabled={claudeCode?.ok === false}>Claude Code (my Claude plan)</option>
								<option value="codex" disabled={codex?.ok === false}>Codex (my ChatGPT plan)</option>
								<option value="anthropic">My Anthropic key</option>
								<option value="openai">My OpenAI key</option>
							</select>
						</label>
						{claudeCode ? (
							<p className={`text-xs ${claudeCode.ok ? "text-muted-foreground" : "text-amber-600"}`}>
								{claudeCode.ok ? `${claudeCode.text}. With it picked, the swarm runs on it.` : claudeCode.text}
							</p>
						) : null}
						{codex ? (
							<p className={`text-xs ${codex.ok ? "text-muted-foreground" : "text-amber-600"}`}>
								{codex.ok ? `${codex.text}. With it picked, the swarm runs on it.` : codex.text}
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
						<p className="text-xs text-muted-foreground">Bugs reads each project's audit reports from audit/, audits/ and reports/. Add any other folder, relative to the project.</p>
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
					{section === "skills" ? <Section title="Skills">
						<p className="text-xs text-muted-foreground">Auditing checklists by other authors, for every project. The agents read them while they prove and review.</p>
						<Skills />
					</Section> : null}
					{section === "remote" ? <Section title="Remote control (MCP)">
						<label className="flex items-center justify-between gap-4">
							<span>
								<span className="font-medium">Let agents follow and steer the swarm through the MCP</span>
								<span className="block text-xs text-muted-foreground">
									The swarm keeps running here. What its agents say goes to your formal.team account as it happens, and the MCP's
									mac_* tools (from Claude, ChatGPT or Cursor, signed in as you) come back to this Mac. Your code stays here.
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
					{section === "github" ? <Section title="GitHub">
						<p className="text-xs text-muted-foreground">
							Off, a folder's work stays on this Mac: nothing is committed, pushed or posted. On, Formal Mind's GitHub App comments
							on that repository's pull requests with what the proof ledger says changed: proofs that broke, approvals that
							lapsed, functions that lost coverage, new findings.
						</p>
						{folders.length === 0 ? <p className="text-xs text-muted-foreground">Add a folder in the sidebar first.</p> : null}
						{folders.map((path) => (
							<label key={path} className="flex items-center justify-between gap-4">
								<span className="min-w-0 truncate font-mono text-xs" title={path}>{path.split("/").filter(Boolean).pop()}</span>
								<input
									type="checkbox"
									checked={github[path] ?? false}
									onChange={(e) => {
										const on = e.target.checked;
										setGithub((g) => ({ ...g, [path]: on }));
										void invoke("control", { op: "github", folder: path, args: { on } }).catch(() => setGithub((g) => ({ ...g, [path]: !on })));
									}}
									className="size-4"
								/>
							</label>
						))}
						<label className="flex items-center justify-between gap-4 border-t pt-3">
							<span>
								Questions
								<span className="block text-xs text-muted-foreground">
									Who answers when the swarm asks whether a statement means what you meant: you, or an MCP client acting
									for you; or an answerer agent, which confirms or corrects each one once and leaves doubts for you.
								</span>
							</span>
							<select
								value={answers}
								onChange={(e) => {
									const who = e.target.value as "mcp" | "agent";
									setAnswers(who);
									void invoke("control", { op: "answers", folder: "", args: { who } }).catch(() => setAnswers(who === "agent" ? "mcp" : "agent"));
								}}
								className="rounded border bg-transparent px-2 py-1 text-xs"
							>
								<option value="mcp">You or the MCP</option>
								<option value="agent">Answerer agent</option>
							</select>
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
