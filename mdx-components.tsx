import type { MDXComponents } from 'mdx/types';
import Image, { ImageProps } from 'next/image';
import Link from 'next/link';

export function useMDXComponents(components: MDXComponents): MDXComponents {
	return {
		h1: ({ children }) => <h1 className="text-3xl font-bold mt-8 mb-4">{children}</h1>,
		h2: ({ children }) => <h2 className="text-2xl font-semibold mt-6 mb-3">{children}</h2>,
		h3: ({ children }) => <h3 className="text-xl font-medium mt-4 mb-2">{children}</h3>,
		p: ({ children }) => <p className="mb-4">{children}</p>,
		code: ({ children }) => (
			<code className="">
				{children}
			</code>
		),
		pre: ({ children }) => (
			<pre className="overflow-x-auto max-w-full dark:bg-gray-900">
				{children}
			</pre>
		),
		a: ({ href, children }) => (
			<Link href={href || '#'} className="text-blue-600 hover:underline">
				{children}
			</Link>
		),
		img: (props) => (
			<Image
				sizes="100vw"
				style={{ width: '100%', height: 'auto' }}
				{...(props as ImageProps)}
			/>
		),
		...components,
	};
}
