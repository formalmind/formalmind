export default function DocsLayout({ children }: { children: React.ReactNode }) {
	return (
		<article className="px-8 max-w-none">
			{children}
		</article>
	);
}
