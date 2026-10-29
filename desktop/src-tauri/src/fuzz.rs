//! Fuzz tests for what decides how agents run and what the MCP is told: the settings' readers, the ledger's readers of
//! Lean's output and the health checks. Seeded random inputs, so a failure repeats; thousands of cases each.

use serde_json::json;

/// xorshift64: a fixed seed gives the same inputs on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn pick<'a>(&mut self, xs: &[&'a str]) -> &'a str {
        xs[(self.next() % xs.len() as u64) as usize]
    }
    /// Text made of pieces that matter to the readers, and noise.
    fn text(&mut self) -> String {
        const PIECES: [&str; 22] = [
            "Except.error", "Except.ok", "ext.set w", "w' =", "L.J ext w' t", ".held", "wp (", "↔ Q ", " w", "Morpho.Morpho.supply",
            "Morpho.supply", ": error:", "error:", "depends on axioms: [sorryAx]", "\n", " ", "..", "/", "🙂", "Q (v)", "ℕ", "∀ x,",
        ];
        (0..(self.next() % 12)).map(|_| self.pick(&PIECES)).collect()
    }
}

#[test]
fn settings_always_give_a_valid_route_effort_and_cap() {
    let mut r = Rng(0x2026_1027);
    let providers = ["claude-code", "formal", "anthropic", "openai", "", "gpt", "CLAUDE-CODE", "../x"];
    let efforts = ["low", "medium", "high", "xhigh", "max", "", "lowest", "LOW", "0"];
    for _ in 0..20_000 {
        let mut s = crate::local::Settings::default();
        if r.next() % 2 == 0 {
            s.provider = Some(r.pick(&providers).into());
        }
        if r.next() % 2 == 0 {
            s.effort = Some(r.pick(&efforts).into());
        }
        let folder = r.pick(&["/a", "/b", ""]);
        if r.next() % 2 == 0 {
            s.budgets.insert(folder.into(), (r.next() % 400) as f64 - 200.0);
        }
        if r.next() % 2 == 0 {
            s.api_base = Some(r.pick(&["", "https://formal.team", "http://localhost:8787"]).into());
        }
        // The route is always one the app can run; an unset or unknown one is the Claude plan.
        assert!(["claude-code", "codex", "formal", "anthropic", "openai"].contains(&s.provider().as_str()));
        if !providers[1..4].contains(&s.provider.as_deref().unwrap_or("")) {
            assert_eq!(s.provider(), "claude-code");
        }
        // Effort is passed to Claude Code only when it's one it accepts.
        assert!(s.effort().is_none_or(|e| ["low", "medium", "high", "xhigh", "max"].contains(&e.as_str())));
        // A cap is always positive; the server address is never empty.
        assert!(s.budget(folder) > 0.0);
        assert!(!s.api_base().is_empty());
        assert!(!s.github(folder));
    }
}

#[test]
fn the_ledger_reads_any_lean_output_without_panicking() {
    let mut r = Rng(0xF0_2026);
    let defs = ["Morpho.supply", "UtilsLib.zeroFloorSub", "WETH9.«»", ""];
    for _ in 0..20_000 {
        let text = r.text();
        let def = r.pick(&defs);
        let covers = crate::swarm2::ledger::covers(&text, def);
        // Coverage needs the statement to be about the def, and only names what it can show.
        if !text.contains(def) {
            assert!(covers.is_empty());
        }
        assert!(covers.iter().all(|c| ["reverts", "writes", "returns", "conservation"].contains(c)));
        if covers.contains(&"reverts") && !text.contains("wp (") {
            assert!(text.contains("Except.error"));
        }
        let _ = crate::swarm2::ledger::is_lean_error(&text);
        assert_eq!(crate::swarm2::ledger::hash(&text), crate::swarm2::ledger::hash(&text));
    }
}

#[test]
fn a_module_never_resolves_outside_the_lake_sources() {
    let mut r = Rng(0xBEEF);
    let root = std::path::Path::new("/p");
    let src = root.join("formal");
    let libs = std::collections::BTreeSet::from(["Refinement".to_string(), "Generated".to_string()]);
    let parts = ["formal", "Refinement", "Generated", "Swarm", "..", ".", "src", "X.lean", "Y", "", "Scratch.lean", "a b"];
    for _ in 0..20_000 {
        let n = 1 + r.next() % 5;
        let file: String = (0..n).map(|_| r.pick(&parts)).collect::<Vec<_>>().join("/");
        if let Some(m) = crate::swarm2::ledger::module_of(&src, root, &file, &libs) {
            assert!(!m.contains(".."), "{file} -> {m}");
            assert!(libs.contains(m.split('.').next().unwrap_or("")), "{file} -> {m}");
            assert!(std::path::Path::new(&file).components().filter(|c| matches!(c, std::path::Component::Normal(_))).last().is_some_and(|c| c.as_os_str().to_string_lossy().ends_with(".lean")), "{file}");
        }
    }
}

#[test]
fn health_never_flags_a_clean_turn_and_always_flags_a_blind_one() {
    let mut r = Rng(0x4EA1);
    let tools = ["read_file", "run", "write_file", "search", "background_results"];
    for _ in 0..5_000 {
        let mut t = crate::health::Turn::new("/f", "swarm", 1, "prover", "1", "claude-code", "m");
        let blind = r.next() % 4 == 0;
        t.tools = Some(if blind { "needs-auth" } else { "connected" }.into());
        let calls = 1 + r.next() % 6;
        for i in 0..calls {
            // Distinct inputs and passing builds: an ordinary working turn.
            t.tool(r.pick(&tools), &json!({ "path": format!("f{i}.lean"), "command": "lake build" }), "exit 0");
        }
        let a = t.anomalies("done");
        if blind {
            assert!(a.iter().any(|x| x.contains("didn't connect")), "{a:?}");
        } else {
            assert!(a.is_empty(), "{a:?}");
        }
    }
}
