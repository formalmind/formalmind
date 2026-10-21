import { useNavigate } from "react-router";
import { ChevronLeft } from "lucide-react";

/** The screen's top bar, under the status bar: back (or the app's mark), the title, and actions on the right. */
export function TopBar({ title, sub, back, left, right }: { title: React.ReactNode; sub?: React.ReactNode; back?: string | true; left?: React.ReactNode; right?: React.ReactNode }) {
	const navigate = useNavigate();
	return (
		<header className="fm-safe-top sticky top-0 z-30 border-b bg-background/85 backdrop-blur-xl">
			<div className="flex h-12 items-center gap-1 px-2">
				{back ? (
					<button type="button" onClick={() => (back === true ? navigate(-1) : navigate(back))} aria-label="Back" className="grid size-10 place-items-center rounded-full text-foreground active:bg-muted">
						<ChevronLeft className="size-6" />
					</button>
				) : (
					<span className="grid size-10 place-items-center">{left}</span>
				)}
				<div className="min-w-0 flex-1">
					<h1 className="truncate text-[15px] font-semibold leading-5">{title}</h1>
					{sub ? <p className="truncate text-[12px] leading-4 text-muted-foreground">{sub}</p> : null}
				</div>
				<div className="flex items-center gap-1 pr-1">{right}</div>
			</div>
		</header>
	);
}
