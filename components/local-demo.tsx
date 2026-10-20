import { SwarmPanel, type Bridge } from "@/desktop/src/swarm-panel";

/**
 * The desktop app's local-folder page, in the browser with made-up data, for design feedback. Shown in the sidebar on
 * localhost only. Messages you send get a canned reply; nothing runs.
 */
const PLAN = [
	{ index: 1, mark: "x", text: "Vault.deposit never mints more shares than the assets are worth, rounding in the vault's favour (src/Vault.sol)" },
	{ index: 2, mark: "x", text: "Vault.withdraw burns at least the shares the assets are worth (src/Vault.sol)" },
	{ index: 3, mark: " ", text: "Lending.liquidate leaves the position's debt at zero and pays the liquidator at most value + 10% penalty (src/Lending.sol)" },
	{ index: 4, mark: " ", text: "Lending.borrow and withdrawCollateral always leave the loan healthy (src/Lending.sol)" },
	{ index: 5, mark: "!", text: "InterestModel: the exchange rate never decreases across accrual (src/InterestModel.sol)" },
	{ index: 6, mark: " ", text: "Oracle.getValue rejects pool prices beyond the allowed deviation (src/Oracle.sol)" },
];
const FILES = { solidity: ["src/Vault.sol", "src/Lending.sol", "src/InterestModel.sol", "src/Oracle.sol", "test/Vault.t.sol", "test/formal/PoC_Liquidate.t.sol"], lean: ["formal/Formal/Vault.lean", "formal/Formal/Lending.lean"], truncated: false, git: true };
const BUGS = [
	{
		file: ".formal/bugs/001-liquidation-penalty-can-exceed-cap.md",
		title: "Liquidation penalty can exceed the 10% cap when the oracle price moves mid-call",
		body: "# Liquidation penalty can exceed the 10% cap when the oracle price moves mid-call\n\n**Severity:** medium\n**Location:** src/Lending.sol:412\n\n## Scenario\n\nThe penalty is computed from the oracle price read at the start of liquidate(), but the payout is computed from the price after the collateral swap callback. A liquidator who moves the pool inside the callback can widen that gap, so the penalty paid exceeds the 10% cap: on a 100k position the liquidator receives 111.8k instead of at most 110k.\n\n## Evidence\n\ntest/formal/PoC_Liquidate.t.sol: `forge test --match-path test/formal/PoC_Liquidate.t.sol` passes, showing the liquidator receiving 11.8% over the debt repaid.",
	},
];
const PROOFS = {
	"1": { item: PLAN[0].text, files: ["formal/Formal/Vault.lean"], summary: "Modelled deposit with floor rounding and proved shares·price ≤ assets for every input. lake build is clean, no sorry.", at: "" },
	"2": { item: PLAN[1].text, files: ["formal/Formal/Vault.lean"], summary: "Withdraw proved the same way; the ceil rounding on shares holds.", at: "" },
};
const SOURCES: Record<string, string> = {
	"test/formal/PoC_Liquidate.t.sol": `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Lending} from "../../src/Lending.sol";

contract PoC_Liquidate is Test {
    function test_penaltyExceedsCap() public {
        // (demo) set up a 100k position, move the pool in the swap callback, liquidate
        uint256 paid = 111_800e18;
        uint256 debt = 100_000e18;
        assertGt(paid, debt * 110 / 100, "liquidator paid more than the 10% cap");
    }
}`,
	"formal/Formal/Vault.lean": `namespace Vault

/-- shares minted for a deposit: floor(assets * supply / total), or assets when empty -/
def sharesFor (assets supply total : Nat) : Nat :=
  if supply = 0 then assets else assets * supply / total

/-- Depositing never mints shares worth more than the assets brought in. -/
theorem deposit_rounds_down (assets supply total : Nat) (h : 0 < total) (hs : 0 < supply) :
    sharesFor assets supply total * total ≤ assets * supply := by
  unfold sharesFor
  simp [Nat.pos_iff_ne_zero.mp hs]
  exact Nat.div_mul_le_self _ _

end Vault
`,
};

const RUN = "local-19a2b3c4d5e";
const ev = (kind: string, role: string, item: string, text: string, spent: number) => ({ run: RUN, kind, role, item, text, spent });
const EVENTS = [
	ev("status", "planner", "plan", "planner is working", 0),
	ev("say", "planner", "plan", "I read the four contracts and the docs, and wrote a 6-item plan: the vault's share math first, then liquidation and health checks.", 0.18),
	ev("plan", "planner", "plan", "6 items", 0.18),
	ev("status", "prover", "1", "prover is working", 0.18),
	ev("tool", "prover", "1", "search function deposit src", 0.2),
	ev("tool", "prover", "1", "read_file src/Vault.sol 120 210", 0.22),
	ev("result", "prover", "1", "120 | function deposit(uint256 assets, address to) external returns (uint256 shares) {\n121 |     shares = previewDeposit(assets);\n122 |     require(shares != 0, \"zero shares\");\n123 |     asset.safeTransferFrom(msg.sender, address(this), assets);", 0.22),
	ev("tool", "prover", "1", "write_file formal/Formal/Vault.lean", 0.41),
	ev("tool", "prover", "1", "run lake build", 0.44),
	ev("say", "prover", "1", "Modelled deposit with floor rounding and proved shares·price ≤ assets for every input. lake build is clean, no sorry.", 0.52),
	ev("status", "reviewer", "1", "reviewer is working", 0.52),
	ev("say", "reviewer", "1", "The statement matches the Solidity, including the zero-supply branch. Approved.", 0.61),
	ev("plan", "reviewer", "1", "item 1 proven", 0.61),
	ev("say", "prover", "2", "Withdraw proved the same way; the ceil rounding on shares holds.", 0.93),
	ev("plan", "reviewer", "2", "item 2 proven", 1.02),
	ev("you", "you", "", "Focus on liquidations next, and check the penalty cap carefully.", 1.02),
	ev("say", "assistant", "you", "Will do: item 3 is liquidation, and I've added the penalty cap to its statement.", 1.06),
	ev("status", "prover", "3", "prover is working", 1.06),
	ev("tool", "prover", "3", "read_file src/Lending.sol 380 460", 1.12),
	ev("bug", "prover", "3", "Liquidation penalty can exceed the 10% cap when the oracle price moves mid-call — .formal/bugs/001-liquidation-penalty-can-exceed-cap.md", 1.61),
	ev("status", "prover", "3", "prover is working", 1.84),
];

const listeners = new Set<(e: { payload: unknown }) => void>();
const demo: Bridge = {
	apiBase: () => "",
	listen: async (_event, cb) => {
		listeners.add(cb as (e: { payload: unknown }) => void);
		return () => listeners.delete(cb as (e: { payload: unknown }) => void);
	},
	invoke: async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
		const answers: Record<string, unknown> = {
			swarm_plan: PLAN,
			swarm_bugs: BUGS,
			swarm_sessions: [{ run: RUN, title: "Liquidations and the penalty cap", outcome: "", spent: 1.84, events: EVENTS.length }],
			swarm_history: EVENTS,
			swarm_proofs: PROOFS,
			folder_read: SOURCES[String(args?.path ?? "")] ?? "// (demo: no contents)\n",
			swarm_running: RUN,
			anthropic_key_status: false,
		};
		if (cmd === "swarm_suggest") return new Promise((done) => setTimeout(() => done("Good catch on the penalty cap. Write the PoC for that bug, then move on to the oracle item." as T), 700));
		if (cmd === "swarm_say") {
			setTimeout(() => {
				for (const l of listeners) l({ payload: ev("say", "assistant", "you", `(demo) Noted: “${String(args?.text ?? "")}”. In the app the assistant answers before the next turn.`, 1.84) });
			}, 900);
		}
		return answers[cmd] as T;
	},
};

export function LocalDemoPage() {
	return <SwarmPanel folder="/Users/you/code/lending-protocol" name="lending-protocol" scan={FILES} bridge={demo} />;
}
