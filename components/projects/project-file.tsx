import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { MarkGithubIcon } from "@primer/octicons-react";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { repoOf } from "@/components/projects/use-projects";

const LANGUAGE: Record<string, string> = { sol: "solidity", lean: "lean", ts: "typescript", tsx: "tsx", js: "javascript", json: "json", md: "markdown", toml: "toml", rs: "rust", py: "python", yml: "yaml", yaml: "yaml", sh: "bash" };

/** A file of a project, opened from the sidebar's tree: read-only, highlighted, with line numbers. */
export function ProjectFilePage() {
	const { owner, name } = useParams();
	const repo = repoOf(owner, name) ?? "";
	const [params] = useSearchParams();
	const path = params.get("path") ?? "";
	const [file, setFile] = useState<{ text: string; url: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		setFile(null);
		setError(null);
		if (!path) return;
		void fetch(`/api/projects/file?repo=${encodeURIComponent(repo)}&path=${encodeURIComponent(path)}`)
			.then(async (r) => {
				const body = await r.json().catch(() => ({}));
				if (!r.ok) throw new Error(body.error ?? "Couldn't open the file.");
				setFile(body);
			})
			.catch((e) => setError(String(e.message ?? e)));
	}, [repo, path]);
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
				{file?.url ? (
					<a href={file.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground">
						<MarkGithubIcon className="size-3.5" />
						Open on GitHub
					</a>
				) : null}
			</header>
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
		</div>
	);
}
