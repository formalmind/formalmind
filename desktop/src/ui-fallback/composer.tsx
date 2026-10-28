/**
 * `@formalmind/ui/composer` without the private UI package: no AffectUI composer, so the chat shows the app's own
 * `ChatComposer` (components/chat-composer.tsx).
 */
export const Composer: null | ((props: {
	value: string;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
	onSubmit: () => void;
	onStop: () => void;
	isLoading: boolean;
	allowEmpty?: boolean;
	sendDisabled?: boolean;
	sendTitle?: string;
	placeholder?: string;
	modelPicker?: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean };
	effortPicker?: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; disabled?: boolean };
	context?: React.ReactNode;
	extra?: React.ReactNode;
	textareaRef?: React.Ref<HTMLTextAreaElement>;
}) => React.ReactNode) = null;
