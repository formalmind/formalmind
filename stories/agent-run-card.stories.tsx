import type { Meta, StoryObj } from "@storybook/react-vite";
import { useState } from "react";
import { RunCard, type Steer } from "@/desktop/src/chat-ui/run-card";
import { type Ev, type Row } from "@/desktop/src/swarm-panel";
import events from "./fixtures/run-card-events.json";

/** The fixture's prover run as rows; with `split`, every other call is the reviewer's, as when both work at once. */
function rows(evs: Ev[], split = false): Row[] {
	const out: Row[] = [];
	let calls = 0;
	for (const e of evs) {
		if (e.kind === "say") out.push({ note: e });
		else if (e.kind === "tool") out.push({ call: { ...e, role: split && calls++ % 2 === 1 ? "reviewer" : e.role } });
		else if (e.kind === "result") {
			const open = [...out].reverse().find((r): r is { call: Ev; result?: Ev } => "call" in r && !r.result);
			if (open) open.result = { ...e, role: open.call.role };
		}
	}
	return out;
}

const Card = RunCard;
const title = "Conservation of supply and borrow shares across repay and withdraw";
const still = (all: Row[]) => [...all.slice(0, -1), { call: (all[all.length - 1] as { call: Ev }).call }];

/** Steering the agent at work: Enter queues a note, which joins a step once one starts after it. */
function Steering() {
	const base = still(rows(events as Ev[]));
	const [notes, setNotes] = useState<Steer[]>([]);
	return <Card steps={base} running title={title} onPause={() => {}} steering={{ notes, send: (text, now, queued) => setNotes((n) => (queued ? n.map((x) => (x.id === queued ? { ...x, now } : x)) : [...n, { id: String(n.length), text, at: Date.now(), now }])) }} />;
}

const meta = {
	title: "Swarm/Agent run card",
	decorators: [(Story) => <div className="max-w-2xl p-6 text-[13px]"><Story /></div>],
} satisfies Meta;
export default meta;

/** Two agents' steps in one stretch of the chat: the Agents tree, then the picked agent's steps. */
export const TwoAgents: StoryObj = { render: () => <Card steps={rows(events as Ev[], true)} running={false} title={title} /> };

/** The same while they work. */
export const TwoAgentsWorking: StoryObj = { render: () => <Card steps={still(rows(events as Ev[], true))} running title={title} onPause={() => {}} /> };

/** One agent at work, with the steering card. */
export const SteeringOne: StoryObj = { render: () => <Steering /> };
