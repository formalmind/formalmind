import { useEffect, useRef } from "react"
import { useSidebar } from "@/components/ui/sidebar"

const KEY = "fm:sidebar-width"
const MIN = 200
const MAX = 420
const DEFAULT = 256

const wrapper = (from: Element | null) => from?.closest<HTMLElement>(".group\\/sidebar-wrapper") ?? null
const apply = (el: HTMLElement | null, px: number) => el?.style.setProperty("--sidebar-width", `${px}px`)

/**
 * A handle on the sidebar's right edge: drag to resize (200–420px), double-click to reset. The width is kept between
 * visits. Hidden while the sidebar is collapsed to icons or on mobile.
 */
export function SidebarResizer() {
	const { state, isMobile } = useSidebar()
	const ref = useRef<HTMLDivElement>(null)

	useEffect(() => {
		let saved = DEFAULT
		try {
			saved = Number(localStorage.getItem(KEY)) || DEFAULT
		} catch {
			// No storage: the default width.
		}
		apply(wrapper(ref.current), Math.min(MAX, Math.max(MIN, saved)))
	}, [])

	if (isMobile || state === "collapsed") return null

	const start = (event: React.PointerEvent) => {
		event.preventDefault()
		const el = wrapper(ref.current)
		const left = el?.querySelector<HTMLElement>("[data-sidebar=sidebar]")?.getBoundingClientRect().left ?? 0
		document.body.style.cursor = "col-resize"
		document.body.style.userSelect = "none"
		// Follow the pointer without the sidebar's width transition, so it tracks the cursor exactly.
		el?.querySelectorAll<HTMLElement>("[class*='transition-[left,right,width]']").forEach((n) => (n.style.transition = "none"))
		let width = DEFAULT
		const move = (e: PointerEvent) => {
			width = Math.round(Math.min(MAX, Math.max(MIN, e.clientX - left + 8)))
			apply(el, width)
		}
		const end = () => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", end)
			document.body.style.cursor = ""
			document.body.style.userSelect = ""
			el?.querySelectorAll<HTMLElement>("[class*='transition-[left,right,width]']").forEach((n) => (n.style.transition = ""))
			try {
				localStorage.setItem(KEY, String(width))
			} catch {
				// Not kept, still applied.
			}
		}
		window.addEventListener("pointermove", move)
		window.addEventListener("pointerup", end)
	}

	return (
		<div
			ref={ref}
			role="separator"
			aria-orientation="vertical"
			aria-label="Resize sidebar"
			title="Drag to resize · double-click to reset"
			onPointerDown={start}
			onDoubleClick={() => {
				apply(wrapper(ref.current), DEFAULT)
				try {
					localStorage.removeItem(KEY)
				} catch {
					// Fine.
				}
			}}
			className="group/resize absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize"
		>
			<span className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/resize:bg-sidebar-border group-active/resize:bg-foreground/30" />
		</div>
	)
}
