import type { Meta, StoryObj } from "@storybook/react-vite";
import { Steps, type Ev } from "@/desktop/src/swarm-panel";
import events from "./fixtures/run-card-events.json";

type Rows = Parameters<typeof Steps>[0]["steps"];

/** A prover's run on morpho-blue, as the chat shows it: its notes, and each tool call with its result. */
function rows(evs: Ev[]): Rows {
	const out: Rows = [];
	for (const e of evs) {
		if (e.kind === "say") out.push({ note: e });
		else if (e.kind === "tool") out.push({ call: e });
		else if (e.kind === "result") {
			const last = out[out.length - 1];
			if (last && "call" in last && !last.result) last.result = e;
		}
	}
	return out;
}

const all = rows(events as Ev[]);

const meta = {
	title: "Swarm/Run card",
	component: Steps,
	decorators: [(Story) => <div className="max-w-xl p-6 text-[13px]"><Story /></div>],
	args: { steps: all, running: false, title: "Conservation of supply and borrow shares across repay and withdraw", onPause: () => {} },
} satisfies Meta<typeof Steps>;
export default meta;

export const Finished: StoryObj<typeof meta> = {};

/** Still working: the last call has no result yet. */
export const Running: StoryObj<typeof meta> = {
	args: { steps: [...all.slice(0, -1), { call: (all[all.length - 1] as { call: Ev }).call }], running: true },
};
