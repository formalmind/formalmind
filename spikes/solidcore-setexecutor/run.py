#!/usr/bin/env python3
"""Measured SolidCore experiment. Execution evidence is never reported as a proof."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import re


WRITE = "asyncOrders[poolId].isExecutor[msg.sender][executor] = allow;"
EMIT = "emit ExecutorSet(poolId, msg.sender, executor, allow);"


def variants(source):
    assert source.count(WRITE) == source.count(EMIT) == 1
    return {
        "baseline": source,
        "reordered": source.replace(WRITE + "\n        " + EMIT, EMIT + "\n        " + WRITE),
        "guarded": source.replace(WRITE, "require(executor != address(0), ZeroAddress());\n        " + WRITE),
        "broken": source.replace("= allow;", "= !allow;"),
    }


def run(command, cwd, timeout=90):
    start = time.monotonic()
    process = subprocess.Popen(command, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, start_new_session=os.name != "nt")
    try:
        output, _ = process.communicate(timeout=timeout)
        code = process.returncode
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)], capture_output=True)
        else:
            os.killpg(process.pid, signal.SIGKILL)
        output, _ = process.communicate()
        output += "\nTimed out; this check did not pass."
        code = 124
    return {"code": code, "seconds": round(time.monotonic() - start, 3), "output": output}


LEAN = r'''
open SolidCore.Solidity.Source
set_option maxRecDepth 10000
set_option maxHeartbeats 4000000
def execute (executor allow : Nat) : Except TypeError CallResult := do
  let core ← SourceUnit.checkedToCoreContract Demo.importedSourceUnit "SetExecutor"
  SourceUnit.checkedCallFunctionWithContext 128 Demo.importedSourceUnit "SetExecutor" "setExecutor"
    { core.context with sender := 11, self := 99 } State.empty
    [.fixedBytes 32 1, .word executor, .word allow]
def observe (executor allow : Nat) : String :=
  match execute executor allow with
  | .error e => "reject:" ++ reprStr e
  | .ok (.reverted _ rd) =>
    match SourceUnit.checkedToCoreContract Demo.importedSourceUnit "SetExecutor" with
    | .error _ => "encoding-error"
    | .ok core => match ABI.Contract.encodeRevertData? core rd with
      | none => "encoding-error"
      | some bytes => "revert:" ++ String.intercalate "," (bytes.map toString)
  | .ok (.returned st _) =>
    let slot := mappingStorageSlot (mappingStorageSlot (mappingStorageSlot 2 1 + 4) 11) executor
    let logs := st.logEntries 99
    toString (st.loadSlot slot) ++ "|" ++ toString logs.length ++ "|" ++
      String.intercalate "," (logs.flatMap (fun e => e.topics.map toString)) ++ "|" ++
      String.intercalate "," (logs.flatMap (fun e => e.data.map toString))
#eval "FM_OBS|22|1|" ++ observe 22 1
#eval "FM_OBS|22|0|" ++ observe 22 0
#eval "FM_OBS|0|1|" ++ observe 0 1
'''

# Identical source-level assertion in every variant. This deliberately uses the kernel,
# not native_decide. A failure is retained, not converted into a successful proof badge.
PROOF = r'''
def preservesPermission (executor allow : Nat) : Bool :=
  match execute executor allow with
  | .ok (.returned st _) =>
    let slot := mappingStorageSlot (mappingStorageSlot (mappingStorageSlot 2 1 + 4) 11) executor
    st.loadSlot slot == allow
  | _ => false
theorem permission_example : preservesPermission 22 1 = true := by decide
#print axioms permission_example
'''

FOUNDRY = r'''
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.35;
import "./SetExecutor.sol";
interface Vm {
    struct Log { bytes32[] topics; bytes data; address emitter; }
    function prank(address) external;
    function load(address, bytes32) external view returns (bytes32);
    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
    function toString(uint256) external pure returns (string memory);
}
contract DemoTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    event log(string);
    function one(uint256 executor, bool allow) internal {
        SetExecutor c = new SetExecutor();
        vm.recordLogs();
        vm.prank(address(11));
        (bool ok, bytes memory returned) = address(c).call(abi.encodeWithSelector(c.setExecutor.selector, bytes32(uint256(1)), address(uint160(executor)), allow));
        string memory prefix = string.concat("FM_OBS|", vm.toString(executor), "|", allow ? "1|" : "0|");
        if (!ok) {
            string memory encoded;
            for (uint i; i < returned.length; i++) encoded = string.concat(encoded, i == 0 ? "" : ",", vm.toString(uint8(returned[i])));
            emit log(string.concat(prefix, "revert:", encoded)); return;
        }
        bytes32 slot = keccak256(abi.encode(executor, keccak256(abi.encode(uint256(11), uint256(keccak256(abi.encode(uint256(1), uint256(2)))) + 4))));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        string memory topics;
        string memory data;
        for (uint i; i < logs.length; i++) {
            for (uint j; j < logs[i].topics.length; j++) topics = string.concat(topics, bytes(topics).length == 0 ? "" : ",", vm.toString(uint256(logs[i].topics[j])));
            for (uint j; j < logs[i].data.length; j++) data = string.concat(data, bytes(data).length == 0 ? "" : ",", vm.toString(uint8(logs[i].data[j])));
        }
        emit log(string.concat(prefix, vm.toString(uint256(vm.load(address(c), slot))), "|", vm.toString(logs.length), "|", topics, "|", data));
    }
    function testAllow() public { one(22, true); }
    function testDeny() public { one(22, false); }
    function testZero() public { one(0, true); }
}
'''


def observations(output):
    result = {}
    for line in output.splitlines():
        line = line.strip()
        if line.startswith('"FM_OBS|'):
            line = json.loads(line)
        if line.startswith("FM_OBS|"):
            _, executor, allow, value = line.split("|", 3)
            key = executor + ":" + allow
            if key in result:
                raise ValueError("Duplicate observation: " + key)
            result[key] = value
    return result


def compare(execution, evm):
    lean = observations(execution["output"])
    actual = observations(evm["output"])
    keys = {"22:1", "22:0", "0:1"}
    parity = execution["code"] == evm["code"] == 0 and set(lean) == keys and lean == actual
    return lean, actual, parity


def save_report(root, report):
    temporary = root / "report.tmp"
    temporary.write_text(json.dumps(report, indent=2))
    temporary.replace(root / "report.json")


def experiment(args):
    root = Path(args.output).resolve()
    root.mkdir(parents=True, exist_ok=True)
    solidcore = Path(args.solidcore).resolve()
    source = Path(args.source).read_text()
    report = {"schema": 1, "scope": "Reduced setExecutor fixture; three concrete calls per variant",
              "proofScope": "One concrete permission example; not a universal refinement theorem",
              "proofSource": PROOF, "proofSha256": hashlib.sha256(PROOF.encode()).hexdigest(),
              "sourceSha256": hashlib.sha256(source.encode()).hexdigest(), "variants": []}
    report["revision"] = run(["git", "rev-parse", "HEAD"], solidcore)["output"].strip()
    if report["revision"] != "16843fdd947b750d9690521d42eefb8be31dbe21":
        raise ValueError("This experiment requires SolidCore commit 16843fdd947b750d9690521d42eefb8be31dbe21.")
    if run(["git", "status", "--porcelain", "--untracked-files=no"], solidcore)["output"].strip():
        raise ValueError("SolidCore has modified tracked files. Use a clean pinned checkout for reproducible evidence.")
    report["toolchain"] = (solidcore / "lean-toolchain").read_text().strip()
    report["solc"] = run([args.solc, "--version"], root)["output"].strip()
    if not re.search(r"Version: 0\.8\.35\+", report["solc"]):
        raise ValueError("The experiment requires solc 0.8.35.")
    save_report(root, report)
    for name, text in variants(source).items():
        work = root / name
        work.mkdir(exist_ok=True)
        (work / "SetExecutor.sol").write_text(text)
        row = {"name": name, "source": text, "sourceSha256": hashlib.sha256(text.encode()).hexdigest()}
        imported = run([args.python, str(solidcore / "scripts/solc_ast_to_lean_source.py"),
                        str(work / "SetExecutor.sol"), "--contract", "SetExecutor", "--solc", args.solc,
                        "--namespace", "Demo", "--body-only"], solidcore)
        row["import"] = imported
        if imported["code"] == 0:
            program = "import SolidCore.Solidity.Checked\nimport SolidCore.Solidity.ABI\nopen SolidCore.Solidity\nopen SolidCore.Solidity.TypeCheck\n" + imported["output"] + LEAN
            (work / "Execute.lean").write_text(program)
            row["execution"] = run([args.lake, "env", "lean", str(work / "Execute.lean")], solidcore)
            (work / "Proof.lean").write_text(program + PROOF)
            row["proof"] = run([args.lake, "env", "lean", str(work / "Proof.lean")], solidcore, 30)
            (work / "Demo.t.sol").write_text(FOUNDRY)
            (work / "foundry.toml").write_text('[profile.default]\nsrc = "."\ntest = "."\nvia_ir = true\noptimizer = true\n')
            row["evm"] = run([args.forge, "test", "--root", str(work), "--use", args.solc, "-vv"], work)
            lean, evm, row["parity"] = compare(row["execution"], row["evm"])
            row["observations"] = {"solidcore": lean, "evm": evm}
            row["permissionMatches"] = row["execution"]["code"] == 0 and set(lean) == {"22:1", "22:0", "0:1"} and all(
                value.startswith("revert:") if name == "guarded" and key == "0:1"
                else value.startswith(key.split(":")[1] + "|1|") for key, value in lean.items())
            row["proofPassed"] = row["proof"]["code"] == 0 and "sorryAx" not in row["proof"]["output"] and "Lean.ofReduceBool" not in row["proof"]["output"]
        report["variants"].append(row)
        save_report(root, report)
    return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--solidcore", required=True)
    parser.add_argument("--source", default=str(Path(__file__).with_name("SetExecutor.sol")))
    parser.add_argument("--output", required=True)
    parser.add_argument("--solc", required=True)
    parser.add_argument("--lake", default="lake")
    parser.add_argument("--forge", default="forge")
    parser.add_argument("--python", default=os.sys.executable)
    args = parser.parse_args()
    experiment(args)
