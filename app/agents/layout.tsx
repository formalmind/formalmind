import 'github-markdown-css/github-markdown-light.css';

export default function DocsLayout({ children }: { children: React.ReactNode }) {
	return (
		<article className="px-8 markdown prose max-w-full">
			{children}
		</article>
	);
}
