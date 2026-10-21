import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { loadDemoData, type DemoData } from "@/components/demo/load";
import { DEMO_TREE } from "@/components/demo-tree";
import { SettingsMenu } from "@/components/projects/swarm-control";
import { NotificationCenter } from "@/components/notification-center";
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
	ev("result", "prover", "1", "lines 120-123 of 260\n  120  function deposit(uint256 assets, address to) external returns (uint256 shares) {\n  121      shares = previewDeposit(assets);\n  122      require(shares != 0, \"zero shares\");\n  123      asset.safeTransferFrom(msg.sender, address(this), assets);", 0.22),
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
/** The demo's bridge: a real repository's files and AST when `data` is there, the sample folder otherwise. */
const makeDemo = (data: DemoData | null): Bridge => ({
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
			folder_read: data ? (data.sources[String(args?.path ?? "")] ?? "// Not in the demo data (only the repository's own text files are).\n") : (SOURCES[String(args?.path ?? "")] ?? "// (demo: no contents)\n"),
			swarm_running: RUN,
			anthropic_key_status: false,
			folder_tree: { files: data ? data.files : DEMO_TREE, truncated: false },
			ast_units: AST_UNITS,
			ast_slice: AST_SLICE,
		};
		if (cmd === "folder_image") {
			const url = data?.images?.[String(args?.path ?? "")];
			if (!url) throw "Not in the demo data.";
			return url as T;
		}
		// Code navigation without a language server: the word under the cursor, declared somewhere in the sources.
		if ((cmd === "lsp_definition" || cmd === "lsp_hover") && data) {
			const text = data.sources[String(args?.path ?? "")] ?? "";
			const line = text.split("\n")[Number(args?.line ?? 0)] ?? "";
			const at = Number(args?.character ?? 0);
			const word = (line.slice(0, at + 1).match(/[\w$]+$/)?.[0] ?? "") + (line.slice(at + 1).match(/^[\w$]+/)?.[0] ?? "");
			const decl = new RegExp(`^\\s*(?:abstract\\s+)?(?:contract|interface|library|struct|enum|error|event|function|modifier|type)\\s+${word}\\b`);
			for (const [path, src] of Object.entries(data.sources)) {
				if (!path.endsWith(".sol") || !word) continue;
				const lines = src.split("\n");
				const i = lines.findIndex((l) => decl.test(l));
				if (i < 0) continue;
				if (cmd === "lsp_definition") return [{ path, line: i, character: lines[i].indexOf(word) }] as T;
				return `\`\`\`solidity\n${lines[i].trim()}\n\`\`\`\n\n${path}:${i + 1}` as T;
			}
			return (cmd === "lsp_definition" ? [] : null) as T;
		}
		if (cmd === "ast_scripts") {
			if (!data?.scripts) throw "No scripts in the demo data.";
			return data.scripts as T;
		}
		if (cmd === "ast_formal") {
			const formal = data?.formals?.[String(args?.entry ?? "")];
			if (!formal) throw "No deployable contract in this file (libraries, interfaces and types have no model).";
			return formal as T;
		}
		if (data && (cmd === "ast_units" || cmd === "ast_slice")) {
			const audit = data.audits[String(args?.entry ?? "")];
			if (!audit) throw "No deployable contract in this file (libraries, interfaces and types have no audit).";
			if (cmd === "ast_slice") return (audit.slices?.[String(args?.function ?? "")] ?? "No slice for this unit.") as T;
			return audit as T;
		}
		if (cmd === "swarm_suggest") return new Promise((done) => setTimeout(() => done("Good catch on the penalty cap. Write the PoC for that bug, then move on to the oracle item." as T), 700));
		if (cmd === "swarm_say") {
			setTimeout(() => {
				for (const l of listeners) l({ payload: ev("say", "assistant", "you", `(demo) Noted: “${String(args?.text ?? "")}”. In the app the assistant answers before the next turn.`, 1.84) });
			}, 900);
		}
		return answers[cmd] as T;
	},
});

const AST_UNITS = {
	contract: "Vault",
	files: 9,
	inScope: 6,
	reachable: 24,
	unusedImports: [],
	ms: 210,
	units: [
		{ name: "Vault.deposit", function: "deposit", mutability: "nonpayable", reads: ["totalAssets", "totalShares", "rate"], writes: ["totalAssets", "totalShares", "balanceOf"], external: 1, guards: 3, arith: 6, unchecked: 0, asm: 0, closure: 5 },
		{ name: "Vault.withdraw", function: "withdraw", mutability: "nonpayable", reads: ["totalAssets", "totalShares", "rate", "balanceOf"], writes: ["totalAssets", "totalShares", "balanceOf"], external: 1, guards: 4, arith: 7, unchecked: 1, asm: 0, closure: 6 },
		{ name: "Lending.liquidate", function: "liquidate", mutability: "nonpayable", reads: ["loans", "debtShares", "rate"], writes: ["loans", "debtShares", "reserves"], external: 3, guards: 5, arith: 12, unchecked: 0, asm: 0, closure: 9 },
		{ name: "Vault.convertToShares", function: "convertToShares", mutability: "view", reads: ["totalAssets", "totalShares"], writes: [], external: 0, guards: 1, arith: 2, unchecked: 0, asm: 0, closure: 2 },
	],
	clusters: [{ units: ["deposit", "withdraw", "liquidate"], shared: ["totalAssets", "totalShares"] }],
};

const AST_SLICE = `# Vault.deposit
external nonpayable · src/Vault.sol:42

## Footprint
- reads: totalAssets, totalShares, rate
- writes: totalAssets, totalShares, balanceOf

## External calls
- Vault.sol:51 \`asset.transferFrom(msg.sender, address(this), assets)\` — external; then writes **totalAssets, totalShares, balanceOf**

## Guards
- Vault.sol:43 if-revert: \`assets == 0\`

## Arithmetic
- Vault.sol:47 \`assets.mulDiv(totalShares, totalAssets)\` — mulDiv uint256, rounds floor
`;

export function LocalDemoPage() {
	const [params] = useSearchParams();
	const [data, setData] = useState<DemoData | null | undefined>(undefined);
	const repo = params.get("repo");
	useEffect(() => void loadDemoData(repo).then(setData), [repo]);
	const bridge = useMemo(() => makeDemo(data ?? null), [data]);
	if (data === undefined) return null;
	const scan = data
		? { solidity: data.files.filter((f) => f.endsWith(".sol")), lean: data.files.filter((f) => f.endsWith(".lean")), truncated: false, git: true }
		: FILES;
	return <SwarmPanel key={data?.path ?? "sample"} folder={data?.path ?? "/Users/you/code/lending-protocol"} name={data?.name ?? "lending-protocol"} scan={scan} bridge={bridge} file={params.get("file")} actions={<><SettingsMenu repos={[]} className="inline-flex size-8 items-center justify-center rounded-full border bg-background/90 text-muted-foreground shadow-sm backdrop-blur hover:text-foreground" /><NotificationCenter /></>} />;
}
