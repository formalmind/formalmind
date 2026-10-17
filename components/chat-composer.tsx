"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUp, Square, ChevronDown, Sparkles, GitBranch } from "lucide-react";
import { RepoIcon } from "@primer/octicons-react";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openAIModelNames, type OpenAIModel } from "@/lib/llm";

/**
 * Concentric corners, same rule as the Mike composer: chips are 32px tall
 * (radius 16) and sit 12px inside the shell, so the shell corner is 28px.
 */
const CHIP = "h-8 rounded-full px-3 text-xs font-medium inline-flex items-center gap-1.5 whitespace-nowrap no-underline";
const MAX_LINES = 6;

export const MODEL_LABELS: Record<OpenAIModel, string> = {
	"gpt-6-luna": "GPT-6 Luna",
	"gpt-6.1-sol": "GPT-6.1 Sol",
	"gpt-6-astra": "GPT-6 Astra",
};

export interface ChatComposerProps {
	value: string;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	onSubmit: () => void;
	onStop: () => void;
	isLoading: boolean;
	model: OpenAIModel;
	onModelChange: (model: OpenAIModel) => void;
	/** "owner/repo" the chat is scoped to, if any. */
	repo?: { owner: string; name: string } | null;
	placeholder?: string;
	textareaRef?: React.Ref<HTMLTextAreaElement>;
}

export function ChatComposer({
	value,
	onChange,
	onSubmit,
	onStop,
	isLoading,
	model,
	onModelChange,
	repo,
	placeholder = "Ask about this repo…",
	textareaRef,
}: ChatComposerProps) {
	const innerRef = React.useRef<HTMLTextAreaElement | null>(null);
	const setRefs = React.useCallback(
		(node: HTMLTextAreaElement | null) => {
			innerRef.current = node;
			if (typeof textareaRef === "function") textareaRef(node);
			else if (textareaRef) (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = node;
		},
		[textareaRef],
	);

	// Grow with content, up to MAX_LINES, then scroll inside.
	React.useLayoutEffect(() => {
		const el = innerRef.current;
		if (!el) return;
		el.style.height = "0px";
		const line = parseFloat(getComputedStyle(el).lineHeight) || 20;
		const max = line * MAX_LINES;
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [value]);

	const hasContent = value.trim().length > 0;
	// While the model is responding and the box is empty, the send button becomes stop.
	const stopMode = isLoading && !hasContent;
	const sendEnabled = stopMode || hasContent;

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		e.preventDefault();
		if (hasContent) onSubmit();
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (stopMode) onStop();
				else if (hasContent) onSubmit();
			}}
			className="rounded-[28px] border border-border bg-card shadow-sm focus-within:border-ring/40 transition-colors motion-reduce:transition-none"
		>
			{/* Shelf: context chips */}
			<div className="flex items-center gap-2 px-3 pt-3">
				{repo ? (
					<Link href={`/github/${repo.owner}/${repo.name}`} className={cn(CHIP, "bg-secondary text-secondary-foreground")}>
						<RepoIcon size={14} />
						<span className="max-w-[12rem] truncate">{repo.owner}/{repo.name}</span>
					</Link>
				) : (
					<Link href="/github" className={cn(CHIP, "bg-secondary text-muted-foreground hover:text-foreground")}>
						<GitBranch className="h-3.5 w-3.5" />
						Choose a repo
					</Link>
				)}
			</div>

			<textarea
				ref={setRefs}
				value={value}
				onChange={onChange}
				onKeyDown={handleKeyDown}
				rows={1}
				placeholder={placeholder}
				aria-label="Message"
				className="block w-full resize-none bg-transparent px-4 py-3 text-sm leading-5 outline-none placeholder:text-muted-foreground"
			/>

			{/* Bottom row: model pill, send/stop */}
			<div className="flex items-center gap-2 px-3 pb-3">
				<DropdownMenu>
					<DropdownMenuTrigger
						className={cn(CHIP, "bg-secondary text-secondary-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring")}
						aria-label="Model"
					>
						<Sparkles className="h-3.5 w-3.5" />
						{MODEL_LABELS[model]}
						<ChevronDown className="h-3 w-3 text-muted-foreground" />
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuRadioGroup value={model} onValueChange={(v) => onModelChange(v as OpenAIModel)}>
							{openAIModelNames.map((m) => (
								<DropdownMenuRadioItem key={m} value={m}>
									{MODEL_LABELS[m]}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>

				<div className="flex-1" />

				<button
					type="submit"
					disabled={!sendEnabled}
					aria-label={stopMode ? "Stop" : "Send"}
					className={cn(
						"flex h-8 w-8 items-center justify-center rounded-full transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
						sendEnabled ? "bg-primary text-primary-foreground" : "bg-secondary text-muted-foreground",
					)}
				>
					{stopMode ? <Square className="h-3.5 w-3.5 fill-current" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
				</button>
			</div>
		</form>
	);
}
