import { useLayoutEffect, useRef } from "react";
import { ArrowUp, Check, ChevronDown, Play, Square } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";

type Picker = { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean };

export type ComposerProps = {
	value: string;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	onSubmit: () => void;
	onStop: () => void;
	/** A session is running: with nothing typed, the button is Stop. */
	isLoading: boolean;
	/** The button works with nothing typed (it starts a session). */
	allowEmpty?: boolean;
	sendDisabled?: boolean;
	sendTitle?: string;
	placeholder?: string;
	modelPicker?: Picker;
	effortPicker?: Picker;
	/** Chips in the foot row: the folder, the item in focus. */
	context?: React.ReactNode;
	/** More controls beside the effort pill (Draft reply). */
	extra?: React.ReactNode;
	textareaRef?: React.Ref<HTMLTextAreaElement>;
	/** The card's corner radius class. */
	rounded?: string;
	/** Accepted for the app's `ChatComposer` call sites; the composer is always the chat's size. */
	compact?: boolean;
	sendClassName?: string;
};

const MAX_LINES = 6;

/** A model or effort pill: its choice, and a menu of the others. */
function Pill({ picker }: { picker: Picker }) {
	const picked = picker.options.find((o) => o.value === picker.value) ?? picker.options[0];
	if (!picked) return null;
	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				disabled={picker.disabled}
				className="inline-flex h-7 max-w-[14rem] shrink-0 items-center gap-1 rounded-full px-2 text-muted-foreground outline-none hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:hover:bg-transparent"
			>
				<span className="truncate">{picked.label}</span>
				<ChevronDown className="size-3.5 shrink-0" />
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-44">
				{picker.options.map((o) => (
					<DropdownMenuItem key={o.value} onSelect={() => picker.onChange(o.value)} className="text-[13px] font-normal">
						{o.label}
						{o.value === picked.value ? <Check className="ml-auto size-3.5" /> : null}
					</DropdownMenuItem>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

/**
 * The swarm chat's composer: a card with the message, the effort pill and extras on the left, the model pill and one
 * round button on the right (Start with nothing typed, Send, Stop while a session runs with nothing typed), and the
 * context chips in a foot row. ↵ sends, ⇧↵ is a new line; the field grows to six lines, then scrolls.
 */
export function Composer({ value, onChange, onSubmit, onStop, isLoading, allowEmpty, sendDisabled, sendTitle, placeholder, modelPicker, effortPicker, context, extra, textareaRef, rounded = "rounded-2xl" }: ComposerProps) {
	const own = useRef<HTMLTextAreaElement | null>(null);
	useLayoutEffect(() => {
		const el = own.current;
		if (!el) return;
		el.style.height = "0px";
		const max = (parseFloat(getComputedStyle(el).lineHeight) || 20) * MAX_LINES;
		el.style.height = `${Math.min(el.scrollHeight, max)}px`;
		el.style.overflowY = el.scrollHeight > max ? "auto" : "hidden";
	}, [value]);
	const typed = value.trim().length > 0;
	const stop = isLoading && !typed;
	const start = !isLoading && !typed;
	const canSend = !sendDisabled && (stop || typed || Boolean(allowEmpty));
	const go = () => {
		if (!canSend) return;
		if (stop) onStop();
		else onSubmit();
	};
	const setRef = (el: HTMLTextAreaElement | null) => {
		own.current = el;
		if (typeof textareaRef === "function") textareaRef(el);
		else if (textareaRef) (textareaRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
	};
	return (
		<section
			aria-label="Message composer"
			style={{ containerType: "inline-size" }}
			className={`${rounded} cursor-text border bg-card text-[13px] font-normal shadow-sm focus-within:border-ring/40`}
			onPointerDown={(e) => {
				if ((e.target as HTMLElement).closest("button, textarea, input, a, [role=menu]")) return;
				e.preventDefault();
				own.current?.focus();
			}}
		>
			<textarea
				ref={setRef}
				value={value}
				onChange={onChange}
				onKeyDown={(e) => {
					if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
					e.preventDefault();
					if (typed || allowEmpty) go();
				}}
				rows={1}
				placeholder={placeholder}
				aria-label="Message"
				spellCheck={false}
				dir="auto"
				className="block w-full resize-none bg-transparent px-3.5 pb-1 pt-3 leading-5 text-foreground outline-none placeholder:text-muted-foreground/70"
			/>
			<div className="flex items-center gap-1 px-2 pb-2 pt-1">
				<div className="flex min-w-0 items-center gap-1">
					{effortPicker ? <Pill picker={effortPicker} /> : null}
					{extra}
				</div>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					{modelPicker ? <Pill picker={modelPicker} /> : null}
					<button
						type="button"
						onClick={go}
						disabled={!canSend}
						aria-label={sendTitle ?? (stop ? "Stop" : start ? "Start" : "Send")}
						title={sendTitle}
						className="grid size-7 place-items-center rounded-full bg-foreground text-background hover:bg-foreground/85 disabled:bg-muted disabled:text-muted-foreground"
					>
						{stop ? <Square className="size-3 fill-current" /> : start ? <Play className="size-3.5 translate-x-px fill-current" /> : <ArrowUp className="size-4" />}
					</button>
				</div>
			</div>
			{context ? <div className="flex items-center gap-2 border-t px-2 py-1.5">{context}</div> : null}
		</section>
	);
}
