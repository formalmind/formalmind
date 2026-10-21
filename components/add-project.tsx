import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router";
import { MarkGithubIcon } from "@primer/octicons-react";
import { ArrowRight, FolderPlus, Loader2 } from "lucide-react";
import { projectPath, refreshProjects } from "@/components/projects/use-projects";
import { inDesktop } from "@/lib/open-web";
import { desktopDownload } from "@/lib/downloads";


/** Opens the Add a project popup from anywhere (the sidebar's +, the project picker): `AddProjectHost` shows it. */
export const openAddProject = () => window.dispatchEvent(new Event("fm:add-project"));

/** "https://github.com/o/r(.git)", "github.com/o/r" or "o/r" as "o/r"; null when it isn't one. */
function repoOf(text: string): string | null {
	const m = text.trim().replace(/\.git$/, "").replace(/\/+$/, "").match(/(?:github\.com[/:])?([\w.-]+)\/([\w.-]+)$/);
	return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Adding a project: a local folder (the Mac app's folder picker; on the web, where there is none, the Mac app's
 * download) or a remote GitHub repository, imported straight into a project that opens on its code. `onLocal` is the
 * Mac app's picker; `initialRepo` opens the card on Remote with that repository filled in (from the landing page).
 */
export function AddProjectCard({ onLocal, onCancel, onDone, initialRepo }: { onLocal?: () => Promise<unknown> | void; onCancel?: () => void; onDone?: () => void; initialRepo?: string }) {
	const navigate = useNavigate();
	const [choice, setChoice] = useState<"local" | "remote" | null>(initialRepo !== undefined ? "remote" : null);
	const [text, setText] = useState(initialRepo ?? "");
	const [adding, setAdding] = useState<{ busy: boolean; error?: string }>({ busy: false });
	const repo = repoOf(text);
	const importRepo = async () => {
		if (!repo) return;
		setAdding({ busy: true });
		const res = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repo }) }).catch(() => null);
		const body = ((await res?.json().catch(() => null)) ?? {}) as { repo?: string; error?: string };
		if (!res?.ok || !body.repo) return setAdding({ busy: false, error: body.error ?? "Couldn't add it. Try again." });
		refreshProjects();
		setAdding({ busy: false });
		// The project opens on its code (the Mac app's project page is its code).
		navigate(inDesktop() ? projectPath(body.repo) : projectPath(body.repo, "code"));
		onDone?.();
	};
	const local = async () => {
		setChoice("local");
		if (!onLocal || !inDesktop()) return;
		await onLocal();
		onDone?.();
	};
	const tile = (on: boolean) => `flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors ${on ? "border-foreground/30 bg-muted" : "bg-background hover:bg-muted/60"}`;
	return (
		<section className="w-full rounded-2xl border bg-muted/60 p-1.5 text-left">
			<header className="flex h-8 items-center px-2.5">
				<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Add a project</span>
				{onCancel ? (
					<button type="button" onClick={onCancel} className="ml-auto rounded-md px-2 text-[12px] text-muted-foreground hover:bg-background hover:text-foreground">
						Cancel
					</button>
				) : null}
			</header>
			<div className="shadow-card space-y-3 rounded-xl border bg-card p-3 text-[13px]">
				<div className="grid grid-cols-2 gap-2">
					<button type="button" onClick={() => void local()} className={tile(choice === "local")}>
						<FolderPlus className="size-5 text-muted-foreground" />
						<span className="font-medium">Local folder</span>
						<span className="text-[12px] text-muted-foreground">A repository on this computer.</span>
					</button>
					<button type="button" onClick={() => setChoice("remote")} className={tile(choice === "remote")}>
						<MarkGithubIcon size={20} className="text-muted-foreground" />
						<span className="font-medium">Remote repository</span>
						<span className="text-[12px] text-muted-foreground">A repository on GitHub.</span>
					</button>
				</div>
				{choice === "local" && !(onLocal && inDesktop()) ? (
					<p className="px-1 text-[12px] text-muted-foreground">
						Local folders open in the desktop app.{" "}
						<a href={desktopDownload().href} className="text-foreground underline underline-offset-2">
							{desktopDownload().label}
						</a>
					</p>
				) : null}
				{choice === "remote" ? (
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void importRepo();
						}}
						className="flex items-center gap-2 rounded-full border bg-background p-1 pl-3.5 focus-within:border-foreground/30"
					>
						<MarkGithubIcon size={14} className="shrink-0 text-muted-foreground" />
						<input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="github.com/owner/repo" aria-label="GitHub repository" className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground" />
						<button type="submit" disabled={!repo || adding.busy} className="btn-dark inline-flex h-7 items-center gap-1 px-3 text-[12px] disabled:opacity-50">
							{adding.busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
							Add {adding.busy ? null : <ArrowRight className="size-3.5" />}
						</button>
					</form>
				) : null}
				{choice === "remote" && adding.error ? (
					<p role="alert" className="px-1 text-[12px] text-red-600 dark:text-red-400">
						{adding.error}
					</p>
				) : null}
			</div>
		</section>
	);
}

/** The Add a project popup, opened by `openAddProject()`; mount once per app. */
export function AddProjectHost({ onLocal }: { onLocal?: () => Promise<unknown> | void }) {
	const [open, setOpen] = useState(false);
	useEffect(() => {
		const show = () => setOpen(true);
		window.addEventListener("fm:add-project", show);
		return () => window.removeEventListener("fm:add-project", show);
	}, []);
	if (!open) return null;
	const close = () => setOpen(false);
	return createPortal(
		<div className="fixed inset-0 z-[60] grid place-items-center bg-black/30 p-4" onMouseDown={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()}>
			<div role="dialog" aria-label="Add a project" className="w-full max-w-md shadow-pop">
				<AddProjectCard onLocal={onLocal} onCancel={close} onDone={close} />
			</div>
		</div>,
		document.body,
	);
}
