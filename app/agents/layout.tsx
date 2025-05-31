import 'github-markdown-css/github-markdown-light.css';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
	return (
		<article className="px-1 markdown prose max-w-full">
			{children}
		</article>
	);
}
