"use client";

import * as React from "react";
import { Link } from "react-router";
import { ArrowUp, Square, ChevronDown, Sparkles, GitBranch } from "lucide-react";
import { RepoIcon } from "@primer/octicons-react";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { openAIModelNames, THINK_LABELS, thinkLevels, type OpenAIModel, type ThinkLevel } from "@/lib/models";

/**
 * Concentric corners, same rule as the Mike composer: chips are 32px tall
 * (radius 16) and sit 12px inside the shell, so the shell corner is 28px.
 */
const CHIP = "h-8 rounded-full px-3 text-sm font-medium inline-flex items-center gap-1.5 whitespace-nowrap no-underline";
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
	/** The model pill; left out where the model isn't the person's choice (agent chats). */
	model?: OpenAIModel;
	onModelChange?: (model: OpenAIModel) => void;
	/** How hard the model thinks; shown in the model pill's menu when given. */
	think?: ThinkLevel;
	onThinkChange?: (think: ThinkLevel) => void;
	/** "owner/repo" the chat is scoped to, if any. */
	repo?: { owner: string; name: string } | null;
	/** Replaces the repo chip on the shelf. */
	context?: React.ReactNode;
	/** A model pill for other providers' models (the local swarm's Claude models), in place of `model`. */
	modelPicker?: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean };
	placeholder?: string;
	/** Extra controls in the bottom row, after the model picker. */
	extra?: React.ReactNode;
	textareaRef?: React.Ref<HTMLTextAreaElement>;
	/** The composer's corner radius class; a container sets it so its own corners nest around it. */
	rounded?: string;
	/** The send button works with nothing typed (it starts a session; what you type is optional). */
	allowEmpty?: boolean;
	/** The send button's look when it's enabled, in place of the primary colour. */
	sendClassName?: string;
	sendDisabled?: boolean;
	/** The send button's tooltip (what it does now: start, send, stop, or why it can't). */
	sendTitle?: string;
}

export function ChatComposer({
	value,
	onChange,
	onSubmit,
	onStop,
	isLoading,
	model,
	onModelChange,
	think,
	onThinkChange,
	repo,
	context,
	extra,
	modelPicker,
	placeholder = "Ask about this repo…",
	textareaRef,
	rounded = "rounded-[28px]",
	allowEmpty = false,
	sendClassName = "bg-primary text-primary-foreground",
	sendDisabled = false,
	sendTitle,
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
	const sendEnabled = !sendDisabled && (stopMode || hasContent || allowEmpty);

	const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
		e.preventDefault();
		if (hasContent) onSubmit();
	};

	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				if (sendDisabled) return;
				if (stopMode) onStop();
				else if (hasContent || allowEmpty) onSubmit();
			}}
			className={`${rounded} border border-border bg-card shadow-sm focus-within:border-ring/40 transition-colors motion-reduce:transition-none`}
		>
			{/* Shelf: context chips */}
			<div className="flex items-center gap-2 px-3 pt-3">
				{context ?? (repo ? (
					<Link to={`/github/${repo.owner}/${repo.name}`} className={cn(CHIP, "bg-secondary text-secondary-foreground")}>
						<RepoIcon size={14} />
						<span className="max-w-[12rem] truncate">{repo.owner}/{repo.name}</span>
					</Link>
				) : (
					<Link to="/github" className={cn(CHIP, "bg-secondary text-muted-foreground hover:text-foreground")}>
						<GitBranch className="h-3.5 w-3.5" />
						Choose a repo
					</Link>
				))}
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

			{/* Bottom row: model pill and extras, send/stop */}
			<div className="flex items-center gap-2 px-3 pb-3">
				{/* One line high: what doesn't fit wraps out of sight, last first (an extra like Draft reply before the
				    pills), so a narrow composer drops options instead of squeezing the send button. The padding keeps
				    focus rings in view. */}
				<div className="-m-1 flex h-10 min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-4 overflow-hidden p-1">
					{model && onModelChange ? (
					<DropdownMenu>
							<DropdownMenuTrigger
								className={cn(CHIP, "bg-secondary text-secondary-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring")}
								aria-label="Model"
							>
								<Sparkles className="h-3.5 w-3.5" />
								{MODEL_LABELS[model]}
								{think ? <span className="font-normal text-muted-foreground">· {THINK_LABELS[think]}</span> : null}
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
								{think && onThinkChange ? (
									<>
										<DropdownMenuSeparator />
										<DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Thinking</DropdownMenuLabel>
										<DropdownMenuRadioGroup value={think} onValueChange={(v) => onThinkChange(v as ThinkLevel)}>
											{thinkLevels.map((t) => (
												<DropdownMenuRadioItem key={t} value={t}>
													{THINK_LABELS[t]}
												</DropdownMenuRadioItem>
											))}
										</DropdownMenuRadioGroup>
									</>
								) : null}
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					{modelPicker ? (
						<DropdownMenu>
							<DropdownMenuTrigger
								disabled={modelPicker.disabled}
								className={cn(CHIP, "bg-secondary text-secondary-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60")}
								aria-label="Model"
							>
								<Sparkles className="h-3.5 w-3.5" />
								{modelPicker.options.find((o) => o.value === modelPicker.value)?.label ?? modelPicker.value}
								<ChevronDown className="h-3 w-3 text-muted-foreground" />
							</DropdownMenuTrigger>
							<DropdownMenuContent align="start">
								<DropdownMenuRadioGroup value={modelPicker.value} onValueChange={modelPicker.onChange}>
									{modelPicker.options.map((o) => (
										<DropdownMenuRadioItem key={o.value} value={o.value}>
											{o.label}
										</DropdownMenuRadioItem>
									))}
								</DropdownMenuRadioGroup>
							</DropdownMenuContent>
						</DropdownMenu>
					) : null}
					{extra}
				</div>

				<button
					type="submit"
					disabled={!sendEnabled}
					aria-label={stopMode ? "Stop" : "Send"}
					title={sendTitle}
					className={cn(
						"flex size-8 shrink-0 items-center justify-center rounded-full transition-colors motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
						sendEnabled ? sendClassName : "bg-secondary text-muted-foreground",
					)}
				>
					{stopMode ? <Square className="h-3.5 w-3.5 fill-current" /> : <ArrowUp className="h-4 w-4" strokeWidth={2.5} />}
				</button>
			</div>
		</form>
	);
}
