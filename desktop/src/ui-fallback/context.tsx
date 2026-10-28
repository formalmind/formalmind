import type { ContextUse } from "../context-panel";

/** `@formalmind/ui/context` without the private UI package: the chat shows the app's own `ContextPanel`. */
export const ContextCard: null | ((props: { role: string; color?: string; use: ContextUse; onCompact?: () => Promise<unknown> }) => React.ReactNode) = null;
