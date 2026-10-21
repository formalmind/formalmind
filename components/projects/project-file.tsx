import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { cachedBytes, cachedFile, syncRepo } from "@/lib/browser-git";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { repoOf } from "@/components/projects/use-projects";

const LANGUAGE: Record<string, string> = { sol: "solidity", lean: "lean", ts: "typescript", tsx: "tsx", js: "javascript", json: "json", md: "markdown", toml: "toml", rs: "rust", py: "python", yml: "yaml", yaml: "yaml", sh: "bash" };

/** Files shown as themselves instead of as text: PDFs in the browser's viewer, images as images. */
const VIEWABLE: Record<string, string> = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml" };

/** A PDF or image from the browser's git copy (fetching it first if need be), as an object URL. */
function useViewable(repo: string, path: string) {
	const type = VIEWABLE[path.split(".").pop()?.toLowerCase() ?? ""];
	const [src, setSrc] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		setSrc(null);
		setFailed(false);
		if (!type || !path) return;
		let live = true;
		let url: string | null = null;
		void (async () => {
			const bytes = (await cachedBytes(repo, path).catch(() => null)) ?? (await syncRepo(repo).then(() => cachedBytes(repo, path)).catch(() => null));
			if (!live) return;
			if (!bytes) return setFailed(true);
			url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
			setSrc(url);
		})();
		return () => {
			live = false;
			if (url) URL.revokeObjectURL(url);
		};
	}, [repo, path, type]);
	return { type, src, failed };
}

/** A file of a project, opened from the sidebar's tree: read-only, highlighted, with line numbers. */
export function ProjectFilePage() {
	const { owner, name } = useParams();
	const repo = repoOf(owner, name) ?? "";
	const [params] = useSearchParams();
	const path = params.get("path") ?? "";
	const [file, setFile] = useState<{ text: string; url: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const view = useViewable(repo, path);
	useEffect(() => {
		setFile(null);
		setError(null);
		if (!path || view.type) return;
		// The browser's git copy first; the API when it hasn't got the file; a fresh fetch when the API fails too.
		const url = `https://github.com/${repo}/blob/HEAD/${path}`;
		let live = true;
		void (async () => {
			const cached = await cachedFile(repo, path).catch(() => null);
			if (cached !== null) return live && setFile({ text: cached, url });
			try {
				const r = await fetch(`/api/projects/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`);
				const body = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(body.error ?? "Couldn't open the file.");
				if (live) setFile(body);
			} catch (e) {
				const text = await syncRepo(repo).then(() => cachedFile(repo, path)).catch(() => null);
				if (!live) return;
				if (text !== null) setFile({ text, url });
				else setError(String((e as Error).message ?? e));
			}
		})();
		return () => {
			live = false;
		};
	}, [repo, path, view.type]);
	const lines = useHighlightedCode(file?.text ?? "", LANGUAGE[path.split(".").pop() ?? ""] ?? "text");

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<header className="flex h-11 shrink-0 items-center gap-2 border-b px-4 text-[13px]">
				<span className="min-w-0 truncate font-mono text-muted-foreground" title={path}>
					{path.split("/").map((part, i, all) => (
						<span key={i} className={i === all.length - 1 ? "text-foreground" : ""}>
							{part}
							{i < all.length - 1 ? " / " : ""}
						</span>
					))}
				</span>
				{file?.url || view.type ? (
					<a href={file?.url ?? `https://github.com/${repo}/blob/HEAD/${path}`} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
						<MarkGithubIcon className="size-3.5" />
						Open on GitHub
					</a>
				) : null}
			</header>
			{view.type ? (
				<div className="flex min-h-0 flex-1 bg-muted/30">
					{view.failed ? (
						<p className="m-auto text-sm text-muted-foreground">Couldn't read this file from the repository.</p>
					) : !view.src ? (
						<p className="m-auto text-sm text-muted-foreground">Opening…</p>
					) : view.type === "application/pdf" ? (
						// The browser's own PDF viewer: pages, zoom, search and download.
						<iframe src={view.src} title={path} className="h-full w-full border-0" />
					) : (
						<img src={view.src} alt={path} className="m-auto max-h-full max-w-full object-contain p-6" />
					)}
				</div>
			) : (
			<div className="min-h-0 flex-1 overflow-auto">
				{error ? <p className="p-6 text-sm text-red-600">{error}</p> : null}
				{!file && !error ? <p className="p-6 text-sm text-muted-foreground">Opening…</p> : null}
				{file ? (
					<pre className="py-3 font-mono text-[12.5px] leading-[1.6]">
						{lines.map((line, i) => (
							<div key={i} className="flex hover:bg-muted/40">
								<span className="w-14 shrink-0 select-none pr-4 text-right text-muted-foreground/60">{i + 1}</span>
								<code className="whitespace-pre pr-6">{line}</code>
							</div>
						))}
					</pre>
				) : null}
			</div>
			)}
		</div>
	);
}
