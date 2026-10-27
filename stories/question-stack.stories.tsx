import type { Meta, StoryObj } from "@storybook/react-vite";
import { QuestionStack, type Ev } from "@/desktop/src/swarm-panel";

const ask = (statement: string, question: string, replies: string[]): Ev => ({ run: "swarm", kind: "ask", role: "assistant", item: statement, text: JSON.stringify({ statement, question, replies }), spent: 0, at: Date.now() });

const asks = [
	ask("S-01", "**S-01**: is this what you meant?\n\n> Morpho's loan-token balance changes by exactly the net change of Σ(totalSupplyAssets − totalBorrowAssets) over the markets with that loan token.\n\nIt would be proved for 8 functions: `Morpho.supply`, `Morpho.withdraw`, `Morpho.borrow`, `Morpho.repay`, `Morpho.liquidate`, `Morpho.flashLoan`, `Morpho.accrueInterest`, `Morpho.setFee`.", ["Yes, S-01 means what I meant.", "No: leave flashLoan out, it nets to zero within the call.", "No: count bad debt as a loss to suppliers."]),
	ask("S-02", "**S-02**: is this what you meant?\n\n> No market's totalBorrowAssets exceeds its totalSupplyAssets after any call.\n\nAssuming: the oracle price is positive.", ["Yes, S-02 means what I meant.", "No: only after accrueInterest."]),
	ask("S-03", "**S-03**: is this what you meant?\n\n> Only the owner can enable an IRM or an LLTV.", ["Yes, S-03 means what I meant.", "No: also the fee recipient."]),
];

/** The agents' open questions above the composer: one at a time, Next to the following one, Send for all. */
const meta = {
	title: "Swarm/Question stack",
	component: QuestionStack,
	decorators: [(Story) => <div className="max-w-md p-6 text-[13px]"><Story /></div>],
	args: { asks, onSend: () => {}, onSkip: () => {}, onWrite: () => {} },
} satisfies Meta<typeof QuestionStack>;
export default meta;

export const Three: StoryObj<typeof meta> = {};
export const One: StoryObj<typeof meta> = { args: { asks: asks.slice(1, 2) } };
