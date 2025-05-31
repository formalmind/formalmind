import type { NextConfig } from "next";
import remarkGfm from 'remark-gfm'
import rehypePrettyCode from 'rehype-pretty-code'
import rehypeCallouts from 'rehype-callouts'
import remarkDirective from 'remark-directive'

/** @type {import('next').NextConfig} */
const nextConfig: NextConfig = {
	/* config options here */
	pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],
	experimental: {}
};

import createMDX from '@next/mdx'

const withMDX = createMDX({
	// Add markdown plugins here, as desired
	extension: /\.(md|mdx)$/,
	options: {
		remarkPlugins: [remarkGfm, remarkDirective],
		rehypePlugins: [
			rehypeCallouts,
			[rehypePrettyCode],
		],
	},
})

// Merge MDX config with Next.js config
export default withMDX(nextConfig)
