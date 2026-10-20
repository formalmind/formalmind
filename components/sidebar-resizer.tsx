import { useSidebar } from "@/components/ui/sidebar"

/** How far left the edge has to be dragged before the sidebar closes. */
const CLOSE_AFTER = 48

/** The sidebar's right edge: drag it left to close the sidebar, like a drawer. Hidden while collapsed or on mobile. */
export function SidebarResizer() {
	const { state, isMobile, setOpen } = useSidebar()
	if (isMobile || state === "collapsed") return null

	const start = (event: React.PointerEvent) => {
		event.preventDefault()
		const from = event.clientX
		document.body.style.cursor = "col-resize"
		document.body.style.userSelect = "none"
		const move = (e: PointerEvent) => {
			if (from - e.clientX < CLOSE_AFTER) return
			end()
			setOpen(false)
		}
		const end = () => {
			window.removeEventListener("pointermove", move)
			window.removeEventListener("pointerup", end)
			document.body.style.cursor = ""
			document.body.style.userSelect = ""
		}
		window.addEventListener("pointermove", move)
		window.addEventListener("pointerup", end)
	}

	return (
		<div
			role="separator"
			aria-orientation="vertical"
			aria-label="Drag left to close the sidebar"
			title="Drag left to close"
			onPointerDown={start}
			className="group/edge absolute inset-y-0 -right-1.5 z-20 w-3 cursor-col-resize"
		>
			<span className="absolute inset-y-3 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors group-hover/edge:bg-border/60" />
		</div>
	)
}
