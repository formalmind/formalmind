import type { Row } from "../swarm-panel";

/**
 * `@formalmind/ui/run-card` without the private UI package (packages/ui, a submodule only some clones have): no
 * AffectUI run card, so the chat shows the app's own `Steps`.
 */
export const RunCard: null | ((props: { steps: Row[]; running: boolean; title?: string; onPause?: () => void }) => React.ReactNode) = null;
