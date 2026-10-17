export default function DocsLayout({ children }: { children: React.ReactNode }) {
	return (
		<article className="px-1 max-w-full">
			{children}
		</article>
	);
}
