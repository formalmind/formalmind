/- An abstract permission specification for trying the proof workspace.
   These theorems do not establish refinement of any Solidity implementation. -/
abbrev Permissions := Nat → Nat → Bool

namespace Permissions

def setExecutor (permissions : Permissions) (maker executor : Nat) (allow : Bool) : Permissions :=
  fun m e => if m = maker ∧ e = executor then allow else permissions m e

theorem permission_updated (permissions : Permissions) (maker executor : Nat) (allow : Bool) :
    Permissions.setExecutor permissions maker executor allow maker executor = allow := by
  simp [setExecutor]

theorem other_maker_unchanged (permissions : Permissions) (maker other executor : Nat)
    (allow : Bool) (different : other ≠ maker) :
    Permissions.setExecutor permissions maker executor allow other executor = permissions other executor := by
  simp [setExecutor, different]

end Permissions
