/**
 * Truncated text fades out instead of ending in "…": every `.truncate` element is watched, and one whose text is wider
 * than its box gets `data-clipped`, which the CSS (src/globals.css) fades at its end. Text that fits is left as it is.
 */
export function fadeTruncation(root: HTMLElement = document.body) {
	const mark = (el: Element) => {
		const h = el as HTMLElement;
		h.toggleAttribute("data-clipped", h.scrollWidth > h.clientWidth + 1);
	};
	const watched = new WeakSet<Element>();
	const sizes = new ResizeObserver((entries) => entries.forEach((e) => mark(e.target)));
	const watch = (el: Element) => {
		if (watched.has(el)) return mark(el);
		watched.add(el);
		sizes.observe(el);
	};
	const scan = (node: Node) => {
		if (!(node instanceof Element)) return;
		if (node.classList.contains("truncate")) watch(node);
		node.querySelectorAll(".truncate").forEach(watch);
	};
	scan(root);
	// New elements, and text that changes inside one already watched (its width may not).
	new MutationObserver((changes) => {
		for (const c of changes) {
			c.addedNodes.forEach(scan);
			const host = (c.target instanceof Element ? c.target : c.target.parentElement)?.closest(".truncate");
			if (host) mark(host);
		}
	}).observe(root, { childList: true, subtree: true, characterData: true });
}
