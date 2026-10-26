import { Children, isValidElement, useEffect, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Link, useLocation } from "react-router";
import { LogoMark } from "@/components/logo";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { MAC_DOWNLOAD } from "@/lib/downloads";
import { DOC_PAGES, pageFor, type DocPage } from "@/content/docs/pages";

/** The pages' Markdown, by file name (`index`, `install`, …). */
const TEXT: Record<string, string> = Object.fromEntries(
	Object.entries(import.meta.glob("/content/docs/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>).map(([path, text]) => [
		path.split("/").pop()!.replace(/\.md$/, ""),
		text,
	]),
);

const SOURCE = "https://github.com/formalmind/formalmind/blob/main/content/docs";

const PROSE =
	"prose prose-sm max-w-none break-words leading-7 dark:prose-invert prose-headings:scroll-mt-20 prose-headings:font-semibold prose-h1:text-2xl prose-h1:mb-4 prose-h2:mt-10 prose-h2:mb-3 prose-h2:text-lg prose-h3:mt-6 prose-h3:text-base prose-p:my-3 prose-ul:my-3 prose-ol:my-3 prose-li:my-1 prose-a:font-normal prose-a:underline-offset-2 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:p-4 prose-pre:text-foreground prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-table:block prose-table:overflow-x-auto prose-th:text-left";

/** A heading's anchor: lower case, words joined by dashes. */
function anchor(children: React.ReactNode): string {
	const text = Children.toArray(children)
		.map((c) => (typeof c === "string" ? c : isValidElement(c) ? String((c.props as { children?: unknown }).children ?? "") : ""))
		.join("");
	return text.toLowerCase().replace(/[`'’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** A page's Markdown. Links to other pages (`/swarm`, `/statements#confirm`) stay in the docs; others open a new tab. */
function DocsMarkdown({ text, base }: { text: string; base: string }) {
	const heading = (Tag: "h2" | "h3") =>
		function Heading({ children }: { children?: React.ReactNode }) {
			const id = anchor(children);
			return (
				<Tag id={id}>
					<a href={`#${id}`} className="no-underline">
						{children}
					</a>
				</Tag>
			);
		};
	return (
		<div className={PROSE}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				rehypePlugins={[[rehypeHighlight, { plainText: ["solidity", "lean", "lean4", "mermaid"] }]]}
				components={{
					pre({ node, children, ...props }) {
						void node;
						const code = Children.toArray(children).find(isValidElement)?.props as { className?: string; children?: React.ReactNode } | undefined;
						if (code?.className?.split(/\s+/).includes("language-mermaid")) return <MermaidDiagram chart={String(code.children ?? "").replace(/\n$/, "")} />;
						return <pre {...props}>{children}</pre>;
					},
					h2: heading("h2"),
					h3: heading("h3"),
					a: ({ node, href = "", ...props }) => {
						void node;
						if (href.startsWith("#")) return <a href={href} {...props} />;
						if (href.startsWith("/") && !href.startsWith("//")) {
							const [path, hash] = href.split("#");
							const to = `${base}${path === "/" ? "" : path}` || "/";
							return <Link to={hash ? `${to}#${hash}` : to} {...props} />;
						}
						return <a href={href} target="_blank" rel="noreferrer" {...props} />;
					},
				}}
			>
				{text}
			</ReactMarkdown>
		</div>
	);
}

function Nav({ base, current, onPick }: { base: string; current: DocPage; onPick?: () => void }) {
	const sections = [...new Set(DOC_PAGES.map((p) => p.section))];
	return (
		<nav aria-label="Docs" className="space-y-6">
			{sections.map((section) => (
				<div key={section}>
					<p className="mb-1.5 px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{section}</p>
					<ul className="space-y-px">
						{DOC_PAGES.filter((p) => p.section === section).map((p) => (
							<li key={p.slug}>
								<Link
									to={`${base}/${p.slug}`.replace(/\/$/, "") || "/"}
									onClick={onPick}
									aria-current={p === current ? "page" : undefined}
									className={`block rounded-md px-2 py-1.5 text-sm ${p === current ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"}`}
								>
									{p.title}
								</Link>
							</li>
						))}
					</ul>
				</div>
			))}
		</nav>
	);
}

/**
 * The docs: docs.formal.team serves them at its root (`base` ""), formal.team at /docs. Public, no sign-in. Agents get
 * the same pages as Markdown from the Worker (`/<page>.md`, or `Accept: text/markdown`).
 */
export function DocsSite({ base }: { base: string }) {
	const { pathname, hash } = useLocation();
	const page = pageFor(pathname.slice(base.length)) ?? DOC_PAGES[0];
	const known = Boolean(pageFor(pathname.slice(base.length)));
	const i = DOC_PAGES.indexOf(page);
	const [prev, next] = [DOC_PAGES[i - 1], DOC_PAGES[i + 1]];
	const href = (p: DocPage) => `${base}/${p.slug}`.replace(/\/$/, "") || "/";
	const text = useMemo(() => TEXT[page.file] ?? `# ${page.title}\n\nThis page is on its way.`, [page]);

	useEffect(() => {
		document.title = page.slug ? `${page.title} · Formal Mind Docs` : "Formal Mind Docs";
	}, [page]);
	// A new page starts at its top, or at the heading its link names.
	useEffect(() => {
		const target = hash ? document.getElementById(decodeURIComponent(hash.slice(1))) : null;
		if (target) target.scrollIntoView();
		else window.scrollTo(0, 0);
	}, [pathname, hash]);

	return (
		<div className="min-h-svh bg-background text-foreground">
			<header className="sticky top-0 z-20 border-b bg-background/90 backdrop-blur">
				<div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
					<Link to={base || "/"} className="flex items-center gap-2">
						<LogoMark size={22} />
						<span className="font-medium">Formal Mind</span>
						<span className="text-muted-foreground">Docs</span>
					</Link>
					<div className="ml-auto flex items-center gap-1">
						<a href="https://formal.team" className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground sm:block">
							formal.team
						</a>
						<a href={MAC_DOWNLOAD} className="rounded-full bg-foreground px-3.5 py-1.5 text-sm text-background hover:opacity-90">
							Download for Mac
						</a>
					</div>
				</div>
			</header>
			<div className="mx-auto flex max-w-6xl gap-10 px-4">
				<aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-56 shrink-0 overflow-y-auto py-8 md:block">
					<Nav base={base} current={page} />
				</aside>
				<main className="min-w-0 flex-1 py-8 md:py-10">
					<details className="mb-6 rounded-lg border md:hidden">
						<summary className="cursor-pointer px-3 py-2 text-sm">
							<span className="text-muted-foreground">{page.section} · </span>
							{page.title}
						</summary>
						<div className="border-t p-2">
							<Nav base={base} current={page} />
						</div>
					</details>
					{known ? null : <p className="mb-6 rounded-lg border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">There's no page at {pathname}; here's the start of the guide.</p>}
					<article className="max-w-3xl">
						<DocsMarkdown text={text} base={base} />
						<div className="mt-12 flex flex-wrap items-center gap-x-4 gap-y-2 border-t pt-5 text-sm text-muted-foreground">
							<a href={`${base}/${page.file}.md`} className="hover:text-foreground">
								View as Markdown
							</a>
							<a href={`${SOURCE}/${page.file}.md`} target="_blank" rel="noreferrer" className="hover:text-foreground">
								Edit on GitHub
							</a>
						</div>
						<div className="mt-6 grid gap-3 sm:grid-cols-2">
							{prev ? (
								<Link to={href(prev)} className="rounded-lg border p-3 hover:bg-muted/50">
									<span className="block text-xs text-muted-foreground">Previous</span>
									<span className="text-sm">{prev.title}</span>
								</Link>
							) : (
								<span />
							)}
							{next ? (
								<Link to={href(next)} className="rounded-lg border p-3 text-right hover:bg-muted/50">
									<span className="block text-xs text-muted-foreground">Next</span>
									<span className="text-sm">{next.title}</span>
								</Link>
							) : null}
						</div>
					</article>
				</main>
			</div>
		</div>
	);
}
