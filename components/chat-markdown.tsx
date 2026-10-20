import { Children, isValidElement } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import type { Schema } from "hast-util-sanitize";
import { MermaidDiagram } from "@/components/mermaid-diagram";

const schema: Schema = {
	...defaultSchema,
	tagNames: [...(defaultSchema.tagNames || []), "details", "summary"],
	attributes: {
		...defaultSchema.attributes,
		code: [...(defaultSchema.attributes?.code || []), ["className", "math-inline", "math-display", "language-mermaid"]],
		details: [...(defaultSchema.attributes?.details || []), "open"],
	},
};

const PROSE =
	"chat-markdown prose prose-sm max-w-none break-words leading-6 dark:prose-invert prose-p:my-2 prose-ul:my-2 prose-ol:my-2 prose-headings:mb-2 prose-headings:mt-4 prose-pre:overflow-x-auto prose-pre:rounded-lg prose-pre:bg-muted prose-pre:p-4 prose-pre:text-foreground prose-code:rounded prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:text-foreground prose-code:before:content-none prose-code:after:content-none prose-table:block prose-table:overflow-x-auto";

/**
 * A model's reply as markdown, the same everywhere: GitHub-flavoured (tables, task lists), math, highlighted code,
 * Mermaid diagrams and a safe subset of HTML; links open in a new tab. `image` maps an image's `src` (a file's
 * Markdown points at paths beside it) to what to load; while it has no answer the image waits.
 */
export function ChatMarkdown({ children, className = "", image }: { children: string; className?: string; image?: (src: string) => string | null | undefined }) {
	return (
		<div className={`${PROSE} ${className}`}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm, remarkMath]}
				rehypePlugins={[rehypeRaw, [rehypeSanitize, schema], [rehypeHighlight, { plainText: ["mermaid"] }], rehypeKatex]}
				components={{
					a: ({ node, ...props }) => {
						void node;
						return <a {...props} target="_blank" rel="noreferrer" />;
					},
					img: ({ node, src, ...props }) => {
						void node;
						const url = typeof src === "string" && image ? image(src) : src;
						return url ? <img {...props} src={url} /> : <span className="inline-block h-24 w-full rounded-md bg-muted" aria-label={props.alt} />;
					},
					pre({ children: content, ...props }) {
						const child = Children.toArray(content).find(isValidElement);
						const code = child?.props as { className?: string; children?: React.ReactNode } | undefined;
						if (code?.className?.split(/\s+/).includes("language-mermaid")) {
							return <MermaidDiagram chart={String(code.children ?? "").replace(/\n$/, "")} />;
						}
						return <pre {...props}>{content}</pre>;
					},
				}}
			>
				{children}
			</ReactMarkdown>
		</div>
	);
}
