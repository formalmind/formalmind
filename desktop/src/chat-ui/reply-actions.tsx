import { useState } from "react";
import { Check, Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

const REASONS = ["Wrong", "Not what I asked", "Too long", "Other"];

/** Under an agent's reply: Copy (a tick for a moment) and a thumbs up or down; down asks why. */
export function ReplyActions({ text }: { text: string }) {
	const [copied, setCopied] = useState(false);
	const [vote, setVote] = useState<"up" | "down" | null>(null);
	const [reason, setReason] = useState<string | null>(null);
	const icon = "grid size-6 place-items-center rounded-md outline-none hover:bg-muted hover:text-foreground";
	return (
		<div className="mt-1 flex items-center gap-1 text-[13px] text-muted-foreground/70 opacity-0 group-hover/reply:opacity-100 has-[[data-state=open]]:opacity-100 [@media(hover:none)]:opacity-100">
			<button
				type="button"
				title="Copy"
				className={icon}
				onClick={() =>
					void navigator.clipboard.writeText(text).then(() => {
						setCopied(true);
						setTimeout(() => setCopied(false), 1500);
					})
				}
			>
				{copied ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-3.5" />}
			</button>
			<button type="button" title="Good reply" className={icon} onClick={() => (setVote(vote === "up" ? null : "up"), setReason(null))}>
				<ThumbsUp className={`size-3.5 ${vote === "up" ? "fill-current text-foreground" : ""}`} />
			</button>
			{vote === "down" ? (
				<button type="button" title="Bad reply" className={icon} onClick={() => (setVote(null), setReason(null))}>
					<ThumbsDown className="size-3.5 fill-current text-foreground" />
				</button>
			) : (
				<DropdownMenu>
					<DropdownMenuTrigger title="Bad reply" className={icon}>
						<ThumbsDown className="size-3.5" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start" className="min-w-44">
						<DropdownMenuLabel className="text-[13px] font-normal text-muted-foreground">What was wrong?</DropdownMenuLabel>
						{REASONS.map((r) => (
							<DropdownMenuItem key={r} onSelect={() => (setVote("down"), setReason(r))} className="text-[13px] font-normal">
								{r}
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			)}
			{reason ? <span className="pl-1 text-muted-foreground">{reason}</span> : null}
		</div>
	);
}
