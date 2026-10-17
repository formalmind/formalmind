import type { NextConfig } from "next";
import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import rehypeCallouts from 'rehype-callouts'
import remarkDirective from 'remark-directive'

/** @type {import('next').NextConfig} */
const nextConfig: NextConfig = {
	/* config options here */
	pageExtensions: ['js', 'jsx', 'md', 'mdx', 'ts', 'tsx'],
	experimental: {},
	images: {
		domains: ['avatars.githubusercontent.com', 'github.com', 'www.youtube.com', 'i.ytimg.com'],
	},
};

import createMDX from '@next/mdx'

const withMDX = createMDX({
	// Add markdown plugins here, as desired
	extension: /\.(md|mdx)$/,
	options: {
		remarkPlugins: [remarkGfm, remarkDirective],
			rehypePlugins: [rehypeCallouts, [rehypeHighlight, { plainText: ['mermaid'] }]],
	},
})

// Cloudflare bindings (the FORMALMIND KV namespace) in `next dev`, backed by wrangler's local state.
initOpenNextCloudflareForDev();

// Merge MDX config with Next.js config
export default withMDX(nextConfig)
