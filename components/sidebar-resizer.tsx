import { PanelLeftClose, PanelLeftOpen } from "lucide-react"
import { useSidebar } from "@/components/ui/sidebar"

/** Dragged this far left of its narrowest, the sidebar closes. */
const CLOSE_BELOW = 140

/**
 * The sidebar's right edge: drag it to resize the sidebar (the width is kept), far left to close it, and right from
 * the collapsed rail to open it again. The tab at its top collapses or expands it with a click. Hidden on mobile.
 */
export function SidebarResizer() {
	const { open, isMobile, setOpen, width, setWidth, setResizing } = useSidebar()
	if (isMobile) return null

	const start = (event: React.PointerEvent) => {
		if (event.button !== 0) return
		event.preventDefault()
		const from = event.clientX
		const base = open ? width : 0
		let moved = false
		const move = (e: PointerEvent) => {
			const next = base + e.clientX - from
			if (!moved && Math.abs(e.clientX - from) < 3) return
			if (!moved) {
				moved = true
				setResizing(true)
			}
			if (next < CLOSE_BELOW) {
				setOpen(false)
				return
			}
			setOpen(true)
			setWidth(next)
		}
		const end = () => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", end)
			setResizing(false)
		}
		window.addEventListener("pointermove", move)
		window.addEventListener("pointerup", end)
	}

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Drag to resize the sidebar"
			title={open ? "Drag to resize · far left to close" : "Drag right to open"}
			onPointerDown={start}
			onDoubleClick={() => setWidth(256)}
			className="group/edge absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize"
		>
			<span className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/edge:bg-border/60" />
			{/* The collapse control lives on the edge itself: a small tab hanging off its top, just outside the line. */}
			<button
				type="button"
				onPointerDown={(e) => e.stopPropagation()}
				onClick={() => setOpen(!open)}
				aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
				title={open ? "Collapse sidebar" : "Expand sidebar"}
				className="absolute left-1/2 top-3 grid h-7 w-5 cursor-pointer place-items-center rounded-r-md border border-l-0 bg-background text-muted-foreground shadow-sm transition-colors hover:text-foreground"
			>
				{open ? <PanelLeftClose className="size-3" /> : <PanelLeftOpen className="size-3" />}
			</button>
		</div>
	)
}
