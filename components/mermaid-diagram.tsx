"use client";

import { useEffect, useId, useState } from "react";
import { useTheme } from "next-themes";

type MermaidDiagramProps = {
	chart: string;
};

export function MermaidDiagram({ chart }: MermaidDiagramProps) {
	const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
	const { resolvedTheme } = useTheme();
	const [svg, setSvg] = useState<string | null>(null);
	const [error, setError] = useState(false);

	useEffect(() => {
		let active = true;
		setSvg(null);
		setError(false);

		async function renderDiagram() {
			try {
				const { default: mermaid } = await import("mermaid");
				mermaid.initialize({
					startOnLoad: false,
					securityLevel: "strict",
					theme: resolvedTheme === "dark" ? "dark" : "neutral",
					themeVariables: resolvedTheme === "dark"
						? { dropShadow: "drop-shadow(0 2px 3px rgba(0, 0, 0, 0.4))" }
						: undefined,
					secure: ["securityLevel", "startOnLoad"],
				});
				const result = await mermaid.render(`mermaid-${id}`, chart);
				if (active) setSvg(result.svg);
			} catch {
				if (active) setError(true);
			}
		}

		void renderDiagram();
		return () => {
			active = false;
		};
	}, [chart, id, resolvedTheme]);

	if (error) {
		return (
			<div className="my-4 rounded-lg border border-border bg-muted/50 p-4">
				<p className="mb-2 text-sm text-muted-foreground">This Mermaid diagram could not be rendered. Source:</p>
				<pre className="overflow-x-auto text-sm text-foreground">{chart}</pre>
			</div>
		);
	}

	if (!svg) {
		return <div className="my-4 rounded-lg bg-muted/50 p-4 text-sm text-muted-foreground" role="status">Rendering diagram…</div>;
	}

	return (
		<div
			className="my-4 overflow-x-auto rounded-lg border border-border bg-card p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
			role="img"
			aria-label="Mermaid diagram"
			dangerouslySetInnerHTML={{ __html: svg }}
		/>
	);
}
