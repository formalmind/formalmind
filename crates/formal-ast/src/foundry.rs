//! foundry.toml as forge reads it: `[profile.default]`, with the active profile (`FOUNDRY_PROFILE`) over it. forge
//! accepts a key in either spelling (`via-ir`, `via_ir`); here both read as the snake_case one.

/// The active profile's name: `FOUNDRY_PROFILE`, else `default`.
pub fn profile_name() -> String {
    std::env::var("FOUNDRY_PROFILE").ok().filter(|s| !s.trim().is_empty()).unwrap_or_else(|| "default".into())
}

fn snake(t: &toml::Table) -> toml::Table {
    t.iter().map(|(k, v)| (k.replace('-', "_"), v.clone())).collect()
}

/// The active profile's settings: the default profile's, with the named profile's keys over them. None when the file
/// doesn't parse.
pub fn profile(text: &str) -> Option<toml::Table> {
    profile_named(text, &profile_name())
}

pub fn profile_named(text: &str, name: &str) -> Option<toml::Table> {
    let doc: toml::Table = toml::from_str(text).ok()?;
    let table = |n: &str| doc.get("profile").and_then(|p| p.get(n)).and_then(|p| p.as_table()).map(snake);
    let mut out = table("default").unwrap_or_default();
    if name != "default" {
        out.extend(table(name).unwrap_or_default());
    }
    Some(out)
}

/// The active profile of the project's foundry.toml (empty when there is none).
pub fn read(root: &std::path::Path) -> toml::Table {
    std::fs::read_to_string(root.join("foundry.toml")).ok().and_then(|t| profile(&t)).unwrap_or_default()
}

/// A string setting of the active profile.
pub fn get_str(p: &toml::Table, key: &str) -> Option<String> {
    p.get(key).and_then(|v| v.as_str()).map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MORPHO: &str = r#"
[profile.default]
via-ir = true
optimizer_runs = 999999

[profile.build]
test = "/dev/null"

[profile.test]
via-ir = false
"#;

    #[test]
    fn a_profile_overrides_the_default_in_either_spelling() {
        let d = profile_named(MORPHO, "default").unwrap();
        assert_eq!(d.get("via_ir").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(d.get("optimizer_runs").and_then(|v| v.as_integer()), Some(999999));
        assert_eq!(d.get("test"), None);
        let t = profile_named(MORPHO, "test").unwrap();
        assert_eq!(t.get("via_ir").and_then(|v| v.as_bool()), Some(false), "the test profile turns via-ir off");
        assert_eq!(t.get("optimizer_runs").and_then(|v| v.as_integer()), Some(999999), "and keeps the default's runs");
        assert_eq!(get_str(&profile_named(MORPHO, "build").unwrap(), "test").as_deref(), Some("/dev/null"));
        assert_eq!(profile_named(MORPHO, "missing").unwrap().get("via_ir").and_then(|v| v.as_bool()), Some(true));
    }
}
