//! The rebuilt swarm core (SPEC.md §5): small modules, each with a test per behaviour it owns. They replace swarm.rs,
//! swarm_ctx.rs and executor.rs one at a time, keeping the commands, events and on-disk formats in SPEC.md §1–2.

#![allow(dead_code)]

pub mod audit;
pub mod events;
pub mod executor;
pub mod fsguard;
pub mod lake;
pub mod ledger;
pub mod plan;
pub mod queue;
pub mod tools;
