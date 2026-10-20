//! The terminal debugger: source, opcodes, stack, memory, storage and calls for one recorded run, with vim keys.
//!
//!   j / k      next / previous opcode          s / S   step into / back
//!   n / N      next / previous line (over)     f / F   step out / back to the call
//!   c / C      continue to breakpoint, watch or revert (forward / back)
//!   g / G      first / last step               /text   search source lines (then ; and , for next / previous)
//!   :b 58  :b File.sol:58   line breakpoint    :w name  break on storage writes naming it
//!   :pc 1621   jump to that pc in this frame   :step 1200  jump to a step     :q  quit
//!   T / :theme dracula   next theme / a theme by name (opaline's builtins; --theme or $SOL_DEBUG_THEME at start)

use crate::highlight::Solidity;
use crate::nav::{Dir, Navigator};
use crate::theme::Theme;
use std::cell::RefCell;
use std::collections::HashMap;
use crate::session::{short_word, Run, Session};
use crate::srcmap::Jump;
use crate::trace::StorageAccess;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use revm::bytecode::opcode::OpCode;

pub struct App<'a> {
    s: &'a Session,
    run: &'a Run,
    title: String,
    nav: Navigator,
    pub cur: usize,
    /// The `:` or `/` line being typed.
    pub input: Option<String>,
    last_search: Option<String>,
    status: String,
    pub theme: Theme,
    highlighter: Option<Solidity>,
    /// Highlight classes per source file, computed the first time a file is shown.
    classes: RefCell<HashMap<i64, Vec<Option<u8>>>>,
}

impl<'a> App<'a> {
    pub fn new(s: &'a Session, run: &'a Run, title: String) -> Self {
        let nav = Navigator::new(s, run);
        // Open on the first statement inside a function (past the dispatcher and the function's own header),
        // else the first step with source.
        let in_body = |i: usize| {
            nav.locs[i].as_ref().is_some_and(|l| l.scope.contains('.') && !matches!(l.node_type.as_str(), "FunctionDefinition" | "ContractDefinition"))
        };
        let cur = (0..nav.len()).find(|&i| in_body(i)).or_else(|| (0..nav.len()).find(|&i| nav.locs[i].is_some())).unwrap_or(0);
        let verdict = if run.success { "ok".to_string() } else { format!("reverted: {}", run.revert_reason().unwrap_or_default()) };
        App {
            s,
            run,
            title,
            nav,
            cur,
            input: None,
            last_search: None,
            status: verdict,
            theme: Theme::initial(None),
            highlighter: Solidity::new(),
            classes: RefCell::new(HashMap::new()),
        }
    }

    pub fn with_theme(mut self, theme: Theme) -> Self {
        self.theme = theme;
        self
    }

    fn block(&self, title: impl Into<String>) -> Block<'static> {
        Block::bordered()
            .border_style(Style::new().fg(self.theme.border))
            .title(Span::styled(title.into(), Style::new().fg(self.theme.accent).add_modifier(Modifier::BOLD)))
            .style(Style::new().bg(self.theme.bg).fg(self.theme.text))
    }

    /// Moves to a step and presses keys, as the UI would (for tests and scripted views).
    pub fn press(&mut self, keys: &str) {
        for c in keys.chars() {
            let code = if c == '\n' { KeyCode::Enter } else { KeyCode::Char(c) };
            self.key(code);
        }
    }

    /// Draws one frame into a buffer of the given size and returns it as text.
    pub fn render_text(&self, width: u16, height: u16) -> String {
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
        term.draw(|f| self.draw(f)).unwrap();
        let buf = term.backend().buffer().clone();
        let mut out = String::new();
        for y in 0..height {
            for x in 0..width {
                out.push_str(buf[(x, y)].symbol());
            }
            out.push('\n');
        }
        out
    }

    pub fn run(mut self) -> std::io::Result<()> {
        if self.nav.is_empty() {
            println!("nothing to show: the run recorded no steps");
            return Ok(());
        }
        let mut terminal = ratatui::init();
        let result = loop {
            if let Err(e) = terminal.draw(|f| self.draw(f)) {
                break Err(e);
            }
            match event::read() {
                Ok(Event::Key(k)) if k.kind == KeyEventKind::Press => {
                    if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
                        break Ok(());
                    }
                    if self.key(k.code) {
                        break Ok(());
                    }
                }
                Ok(_) => {}
                Err(e) => break Err(e),
            }
        };
        ratatui::restore();
        result
    }

    /// Handles a key; true to quit.
    pub fn key(&mut self, code: KeyCode) -> bool {
        if let Some(input) = &mut self.input {
            match code {
                KeyCode::Esc => self.input = None,
                KeyCode::Backspace => {
                    input.pop();
                    if input.is_empty() {
                        self.input = None;
                    }
                }
                KeyCode::Enter => {
                    let line = self.input.take().unwrap_or_default();
                    return self.command(&line);
                }
                KeyCode::Char(c) => input.push(c),
                _ => {}
            }
            return false;
        }
        let steps = &self.run.trace.steps;
        let last = self.nav.len() - 1;
        let to = match code {
            KeyCode::Char('q') => return true,
            KeyCode::Char('j') | KeyCode::Down => Some((self.cur + 1).min(last)),
            KeyCode::Char('k') | KeyCode::Up => Some(self.cur.saturating_sub(1)),
            KeyCode::Char('s') => self.nav.step_into(self.cur, Dir::Forward),
            KeyCode::Char('S') => self.nav.step_into(self.cur, Dir::Back),
            KeyCode::Char('n') | KeyCode::Char('l') | KeyCode::Right => self.nav.step_over(self.cur, Dir::Forward),
            KeyCode::Char('N') | KeyCode::Char('h') | KeyCode::Left => self.nav.step_over(self.cur, Dir::Back),
            KeyCode::Char('f') => self.nav.step_out(self.cur, Dir::Forward),
            KeyCode::Char('F') => self.nav.step_out(self.cur, Dir::Back),
            KeyCode::Char('c') => self.nav.continue_to(self.cur, Dir::Forward, steps),
            KeyCode::Char('C') => self.nav.continue_to(self.cur, Dir::Back, steps),
            KeyCode::Char('g') | KeyCode::Home => Some(0),
            KeyCode::Char('G') | KeyCode::End => Some(last),
            KeyCode::Char(';') => self.last_search.clone().and_then(|t| self.nav.search(self.s, self.cur, Dir::Forward, &t)),
            KeyCode::Char(',') => self.last_search.clone().and_then(|t| self.nav.search(self.s, self.cur, Dir::Back, &t)),
            KeyCode::Char(':') => {
                self.input = Some(":".into());
                None
            }
            KeyCode::Char('/') => {
                self.input = Some("/".into());
                None
            }
            KeyCode::Char('T') => {
                self.theme = self.theme.cycle(1);
                self.status = format!("theme {}", self.theme.name);
                return false;
            }
            _ => None,
        };
        match to {
            Some(i) => {
                self.cur = i;
                self.status.clear();
            }
            None if !matches!(code, KeyCode::Char(':') | KeyCode::Char('/')) => self.status = "no further step that way".into(),
            None => {}
        }
        false
    }

    fn command(&mut self, line: &str) -> bool {
        if let Some(text) = line.strip_prefix('/') {
            self.last_search = Some(text.to_string());
            match self.nav.search(self.s, self.cur, Dir::Forward, text) {
                Some(i) => self.cur = i,
                None => self.status = format!("no later line contains {text:?}"),
            }
            return false;
        }
        let cmd = line.trim_start_matches(':').trim();
        let (verb, arg) = cmd.split_once(' ').map(|(v, a)| (v, a.trim())).unwrap_or((cmd, ""));
        match verb {
            "q" | "quit" => return true,
            "b" | "break" => {
                let (file, line) = match arg.rsplit_once(':') {
                    Some((f, l)) => (self.s.sources.files.values().find(|x| x.name.ends_with(f)).map(|x| x.id), l.parse().ok()),
                    None => (self.nav.locs[self.cur].as_ref().map(|l| l.entry.file), arg.parse().ok()),
                };
                match (file, line) {
                    (Some(f), Some(l)) => {
                        if let Some(p) = self.nav.breakpoints.iter().position(|b| *b == (f, l)) {
                            self.nav.breakpoints.remove(p);
                            self.status = format!("breakpoint at line {l} removed");
                        } else {
                            self.nav.breakpoints.push((f, l));
                            self.status = format!("breakpoint at line {l}; c continues to it");
                        }
                    }
                    _ => self.status = "usage: :b 58  or  :b File.sol:58".into(),
                }
            }
            "theme" => match Theme::load(arg) {
                Some(t) => {
                    self.theme = t;
                    self.status = format!("theme {arg}");
                }
                None => self.status = format!("themes: {}", Theme::names().join(" ")),
            },
            "w" | "watch" if !arg.is_empty() => {
                self.nav.watches.push(arg.to_string());
                self.status = format!("watching writes to {arg}; c continues to the next one");
            }
            "step" => match arg.parse::<usize>() {
                Ok(i) if i < self.nav.len() => self.cur = i,
                _ => self.status = format!("steps go from 0 to {}", self.nav.len() - 1),
            },
            "pc" => {
                let frame = self.run.trace.steps[self.cur].frame;
                let pc = arg.trim_start_matches("0x");
                let pc = if arg.starts_with("0x") { usize::from_str_radix(pc, 16).ok() } else { pc.parse().ok() };
                match pc.and_then(|pc| (0..self.nav.len()).find(|&i| self.run.trace.steps[i].frame == frame && self.run.trace.steps[i].pc == pc)) {
                    Some(i) => self.cur = i,
                    None => self.status = format!("pc {arg} doesn't run in this frame"),
                }
            }
            _ => self.status = format!("unknown command {cmd:?}"),
        }
        false
    }

    fn draw(&self, f: &mut Frame) {
        self.draw_in(f, f.area(), true);
    }

    /// Draws into part of the screen (the split view gives each run half). An unfocused view dims its header.
    pub fn draw_in(&self, f: &mut Frame, area: Rect, focused: bool) {
        f.render_widget(Block::new().style(Style::new().bg(self.theme.bg).fg(self.theme.text)), area);
        let [header, body, footer] = Layout::vertical([Constraint::Length(2), Constraint::Min(6), Constraint::Length(if focused { 2 } else { 0 })]).areas(area);
        let [top, bottom] = Layout::vertical([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(body);
        let [source, calls] = Layout::horizontal([Constraint::Percentage(62), Constraint::Percentage(38)]).areas(top);
        let [ops, stack, memory, storage] = Layout::horizontal([
            Constraint::Percentage(24),
            Constraint::Percentage(22),
            Constraint::Percentage(24),
            Constraint::Percentage(30),
        ])
        .areas(bottom);
        self.draw_header(f, header, focused);
        self.draw_source(f, source);
        self.draw_calls(f, calls);
        self.draw_ops(f, ops);
        self.draw_stack(f, stack);
        self.draw_memory(f, memory);
        self.draw_storage(f, storage);
        self.draw_footer(f, footer);
    }

    fn draw_header(&self, f: &mut Frame, area: Rect, focused: bool) {
        let st = &self.run.trace.steps[self.cur];
        let loc = &self.nav.locs[self.cur];
        let place = loc.as_ref().map(|l| format!("{}:{}  {}", l.file, l.line, l.scope)).unwrap_or("<no source>".into());
        let op = OpCode::new(st.op).map(|o| o.as_str()).unwrap_or("INVALID");
        let line1 = Line::from(vec![
            Span::styled(
                format!(" {} ", self.title),
                if focused {
                    Style::new().fg(self.theme.bg).bg(self.theme.accent).add_modifier(Modifier::BOLD)
                } else {
                    Style::new().fg(self.theme.bg).bg(self.theme.dim)
                },
            ),
            Span::styled(format!("  step {}/{}  depth {}  pc {}  {op}  gas {}", self.cur, self.nav.len() - 1, st.depth, st.pc, st.gas_left), Style::new().fg(self.theme.muted)),
        ]);
        let line2 = Line::from(vec![
            Span::styled(format!(" {place}"), Style::new().fg(self.theme.accent2).add_modifier(Modifier::BOLD)),
            Span::styled(format!("   {}", loc.as_ref().map(|l| l.node_type.as_str()).unwrap_or("")), Style::new().fg(self.theme.muted)),
        ]);
        f.render_widget(Paragraph::new(vec![line1, line2]), area);
    }

    fn draw_source(&self, f: &mut Frame, area: Rect) {
        let loc = self.nav.locs[self.cur].as_ref().or_else(|| (0..self.cur).rev().find_map(|i| self.nav.locs[i].as_ref()));
        let Some(loc) = loc else {
            f.render_widget(Paragraph::new("no source for this step").block(self.block(" source ")), area);
            return;
        };
        let file = &self.s.sources.files[&loc.entry.file];
        let mut cache = self.classes.borrow_mut();
        let classes = cache.entry(file.id).or_insert_with(|| match &self.highlighter {
            Some(h) if file.name.ends_with(".sol") => h.classes(&file.text),
            _ => vec![None; file.text.len()],
        });
        let height = area.height.saturating_sub(2) as usize;
        let first = loc.line.saturating_sub(height / 2).max(1);
        let exact = self.nav.locs[self.cur].is_some();
        let (start, end) = (loc.entry.start as usize, (loc.entry.start + loc.entry.length) as usize);
        let t = &self.theme;
        let mut lines = Vec::new();
        for n in first..(first + height).min(file.line_count() + 1) {
            let text = file.line_text(n);
            let offset = file.line_start(n);
            let here = n == loc.line;
            let bp = if self.nav.breakpoints.contains(&(file.id, n)) { "●" } else { " " };
            let gutter_style = if here { Style::new().fg(t.warn).add_modifier(Modifier::BOLD) } else { Style::new().fg(t.dim) };
            let mut spans = vec![Span::styled(format!("{bp}{n:>5} "), gutter_style)];
            // Runs of bytes that share a colour and a background: syntax from tree-sitter, the current line and the
            // current AST node's src on top.
            let style_at = |i: usize| {
                let mut st = Style::new().fg(t.code_color(classes.get(i).copied().flatten()));
                if here {
                    st = st.bg(t.line_bg);
                    if i >= start && i < end {
                        st = if exact { st.bg(t.node_bg).add_modifier(Modifier::BOLD) } else { st.bg(t.node_bg) };
                    }
                }
                st
            };
            let mut run_start = 0;
            let bytes = text.len();
            for i in 1..=bytes {
                let boundary = i == bytes || (text.is_char_boundary(i) && style_at(offset + i) != style_at(offset + run_start));
                if boundary && text.is_char_boundary(i) {
                    spans.push(Span::styled(text[run_start..i].to_string(), style_at(offset + run_start)));
                    run_start = i;
                }
            }
            if here {
                // Fill the rest of the current line.
                spans.push(Span::styled(" ".repeat(area.width as usize), Style::new().bg(t.line_bg)));
            }
            lines.push(Line::from(spans));
        }
        let title = format!(" {} ", file.name);
        f.render_widget(Paragraph::new(lines).block(self.block(title)), area);
    }

    fn draw_calls(&self, f: &mut Frame, area: Rect) {
        let frames = &self.run.trace.frames;
        let cur_frame = self.run.trace.steps[self.cur].frame;
        // Frames open at this step: the current one and its callers (each the last earlier frame one level up).
        let mut open = vec![cur_frame];
        while let Some(&f0) = open.last() {
            let d = frames[f0].depth;
            match (0..f0).rev().find(|&i| frames[i].depth + 1 == d) {
                Some(p) if d > 0 => open.push(p),
                _ => break,
            }
        }
        let mut lines = Vec::new();
        for (i, fr) in frames.iter().enumerate() {
            let is_open = open.contains(&i);
            let style = if i == cur_frame {
                Style::new().fg(self.theme.warn).add_modifier(Modifier::BOLD)
            } else if is_open {
                Style::new().fg(self.theme.text)
            } else {
                Style::new().fg(self.theme.dim)
            };
            let who = if fr.kind == "DELEGATECALL" {
                format!("{} ⇒ {}", self.s.name_of(fr.target), self.s.name_of(fr.code_address))
            } else {
                format!("{} → {}", self.s.name_of(fr.caller), self.s.name_of(fr.target))
            };
            let call = shorten(&compact_hex(&self.s.describe_call(fr.code_address, &fr.input)), 70);
            let ok = match fr.success {
                Some(true) => "",
                Some(false) => " ✗",
                None => " …",
            };
            lines.push(Line::styled(format!("{}{} {who} {call}{ok}", "  ".repeat(fr.depth), short_kind(fr.kind)), style));
        }
        let height = area.height.saturating_sub(2) as usize;
        let skip = cur_frame.saturating_sub(height / 2).min(lines.len().saturating_sub(height));
        let lines: Vec<Line> = lines.into_iter().skip(skip).collect();
        f.render_widget(Paragraph::new(lines).block(self.block(" calls ")), area);
    }

    fn draw_ops(&self, f: &mut Frame, area: Rect) {
        let st = &self.run.trace.steps[self.cur];
        let height = area.height.saturating_sub(2) as usize;
        let mut lines = Vec::new();
        match self.s.code_of(&self.run.trace, st) {
            Some((_, map)) => {
                let ix = map.pc_to_ix.get(st.pc).copied().unwrap_or(0);
                let from = ix.saturating_sub(height / 2);
                for i in from..(from + height).min(map.ix_to_pc.len()) {
                    let pc = map.ix_to_pc[i];
                    let op = map.code[pc];
                    let name = OpCode::new(op).map(|o| o.as_str()).unwrap_or("?");
                    let imm = if (0x60..=0x7f).contains(&op) {
                        let n = (op - 0x5f) as usize;
                        format!(" 0x{}", revm::primitives::hex::encode(map.code.get(pc + 1..pc + 1 + n).unwrap_or(&[])))
                    } else {
                        String::new()
                    };
                    let jump = match map.entries.get(i).map(|e| e.jump) {
                        Some(Jump::In) if op == 0x56 => " ↘",
                        Some(Jump::Out) if op == 0x56 => " ↗",
                        _ => "",
                    };
                    let text = shorten(&format!("{pc:>5} {name}{imm}{jump}"), area.width.saturating_sub(3) as usize);
                    let style = if pc == st.pc {
                        Style::new().fg(self.theme.bg).bg(self.theme.warn).add_modifier(Modifier::BOLD)
                    } else if matches!(op, 0x55 | 0x54) {
                        Style::new().fg(self.theme.accent2)
                    } else if matches!(op, 0xf0..=0xff) {
                        Style::new().fg(self.theme.accent)
                    } else {
                        Style::new().fg(self.theme.text)
                    };
                    lines.push(Line::styled(text, style));
                }
            }
            None => lines.push(Line::raw("code not from this compile")),
        }
        f.render_widget(Paragraph::new(lines).block(self.block(" opcodes ")), area);
    }

    fn draw_stack(&self, f: &mut Frame, area: Rect) {
        let st = &self.run.trace.steps[self.cur];
        let lines: Vec<Line> = st
            .stack
            .iter()
            .rev()
            .enumerate()
            .take(area.height.saturating_sub(2) as usize)
            .map(|(i, v)| Line::from(vec![Span::styled(format!("{i:>2} "), Style::new().fg(self.theme.dim)), Span::styled(short_word(*v), Style::new().fg(self.theme.code_color(None)))]))
            .collect();
        let title = match st.result {
            Some(r) => format!(" stack · result {} ", short_word(r)),
            None => " stack ".into(),
        };
        f.render_widget(Paragraph::new(lines).block(self.block(title)), area);
    }

    fn draw_memory(&self, f: &mut Frame, area: Rect) {
        let steps = &self.run.trace.steps;
        let st = &steps[self.cur];
        let frame = st.frame;
        let first = self.run.trace.frames.get(frame).map(|fr| fr.first_step).unwrap_or(0);
        // Memory before this step: the frame starts empty; replay its writes.
        let mut mem = vec![0u8; st.memory_size];
        let mut fresh = vec![];
        for (i, s) in steps.iter().enumerate().take(self.cur).skip(first) {
            if s.frame != frame {
                continue;
            }
            for (off, bytes) in &s.memory_writes {
                if mem.len() < off + bytes.len() {
                    mem.resize(off + bytes.len(), 0);
                }
                mem[*off..off + bytes.len()].copy_from_slice(bytes);
                if i + 1 == self.cur || steps[i + 1..self.cur].iter().all(|x| x.frame != frame) {
                    fresh.push(*off);
                }
            }
        }
        let mut lines = Vec::new();
        for (row, chunk) in mem.chunks(32).enumerate() {
            let off = row * 32;
            let hex = revm::primitives::hex::encode(chunk);
            let style = if fresh.contains(&off) { Style::new().fg(self.theme.warn) } else { Style::new().fg(self.theme.muted) };
            let label = if off == 0x40 { "fp" } else { "  " };
            lines.push(Line::from(vec![
                Span::styled(format!("{off:>4x}{label} "), Style::new().fg(self.theme.dim)),
                Span::styled(shorten_mid(&hex, area.width.saturating_sub(10) as usize), style),
            ]));
        }
        let height = area.height.saturating_sub(2) as usize;
        let skip = lines.len().saturating_sub(height).min(fresh.first().map(|o| o / 32).unwrap_or(0).saturating_sub(height / 2));
        let lines: Vec<Line> = lines.into_iter().skip(skip).collect();
        f.render_widget(Paragraph::new(lines).block(self.block(format!(" memory · {} bytes ", st.memory_size))), area);
    }

    fn draw_storage(&self, f: &mut Frame, area: Rect) {
        let steps = &self.run.trace.steps;
        let height = area.height.saturating_sub(2) as usize;
        let mut lines = Vec::new();
        // The latest accesses up to this step, newest first.
        for i in (0..=self.cur).rev() {
            let (Some(text), Some(access)) = (&self.nav.storage[i], &steps[i].storage) else { continue };
            let color = match access {
                StorageAccess::Write { .. } => self.theme.accent2,
                StorageAccess::Read { .. } => self.theme.muted,
            };
            let style = if i == self.cur { Style::new().fg(color).add_modifier(Modifier::BOLD | Modifier::REVERSED) } else { Style::new().fg(color) };
            let who = self.s.name_of(steps[i].address);
            lines.push(Line::styled(shorten(&compact_hex(&format!("{who}: {text}")), area.width.saturating_sub(2) as usize), style));
            if lines.len() >= height {
                break;
            }
        }
        f.render_widget(Paragraph::new(lines).block(self.block(" storage (newest first) ")), area);
    }

    fn draw_footer(&self, f: &mut Frame, area: Rect) {
        let help = "Tab other run (split)  = divergence  T theme  j/k op  n/N line  s/S into  f/F out  c/C continue  g/G ends  /search ;,  :b line  :w var  :pc n  :q";
        let second = match &self.input {
            Some(i) => Line::styled(i.clone(), Style::new().fg(self.theme.text).add_modifier(Modifier::BOLD)),
            None => Line::styled(self.status.clone(), Style::new().fg(self.theme.accent)),
        };
        let style = Style::new().bg(self.theme.bg);
        f.render_widget(Paragraph::new(vec![Line::styled(help, Style::new().fg(self.theme.dim)), second]).block(Block::new().borders(Borders::NONE).style(style)), area);
    }
}

fn short_kind(kind: &str) -> &str {
    match kind {
        "DELEGATECALL" => "DCALL",
        "STATICCALL" => "SCALL",
        k => k,
    }
}

fn shorten(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

fn shorten_mid(s: &str, max: usize) -> String {
    if s.len() <= max || max < 8 {
        s.to_string()
    } else {
        let half = (max - 1) / 2;
        format!("{}…{}", &s[..half], &s[s.len() - half..])
    }
}

/// Long hex runs (mapping keys, pool ids, addresses) as `0x3e76cc…a14c`, so a storage path stays readable.
fn compact_hex(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(i) = rest.find("0x") {
        out.push_str(&rest[..i]);
        let hex_len = rest[i + 2..].chars().take_while(|c| c.is_ascii_hexdigit()).count();
        let run = &rest[i..i + 2 + hex_len];
        if hex_len > 16 {
            out.push_str(&format!("{}…{}", &run[..8], &run[run.len() - 4..]));
        } else {
            out.push_str(run);
        }
        rest = &rest[i + 2 + hex_len..];
    }
    out.push_str(rest);
    out
}

/// The split view drawn once into a buffer, as text (for snapshots).
pub fn split_text(a: &App, b: &App, width: u16, height: u16) -> String {
    let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(width, height)).unwrap();
    term.draw(|f| {
        let [top, bottom] = Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(f.area());
        a.draw_in(f, top, true);
        b.draw_in(f, bottom, false);
    })
    .unwrap();
    let buf = term.backend().buffer().clone();
    let mut out = String::new();
    for y in 0..height {
        for x in 0..width {
            out.push_str(buf[(x, y)].symbol());
        }
        out.push('\n');
    }
    out
}

/// Two runs of the same test, one above the other, both opened at their first divergence. Tab switches which one
/// the keys move; `=` puts both back at the divergence.
pub fn split(sa: &Session, ra: &Run, la: &str, sb: &Session, rb: &Run, lb: &str, report: &crate::diff::Report) -> std::io::Result<()> {
    let first = report.first();
    let mut a = App::new(sa, ra, format!("{la}  {}", first.map(|d| format!("· {} #{} differs", d.what, d.index)).unwrap_or("· no divergence".into())));
    let mut b = App::new(sb, rb, lb.to_string());
    let home = (first.and_then(|d| d.a_step), first.and_then(|d| d.b_step));
    if let Some(i) = home.0 {
        a.cur = i;
    }
    if let Some(i) = home.1 {
        b.cur = i;
    }
    let mut focus_b = false;
    let mut terminal = ratatui::init();
    let result = loop {
        let drawn = terminal.draw(|f| {
            let [top, bottom] = Layout::vertical([Constraint::Percentage(50), Constraint::Percentage(50)]).areas(f.area());
            a.draw_in(f, top, !focus_b);
            b.draw_in(f, bottom, focus_b);
        });
        if let Err(e) = drawn {
            break Err(e);
        }
        match event::read() {
            Ok(Event::Key(k)) if k.kind == KeyEventKind::Press => {
                if k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('c') {
                    break Ok(());
                }
                let typing = if focus_b { b.input.is_some() } else { a.input.is_some() };
                match k.code {
                    KeyCode::Tab if !typing => focus_b = !focus_b,
                    KeyCode::Char('T') if !typing => {
                        a.theme = a.theme.cycle(1);
                        b.theme = a.theme.clone();
                    }
                    KeyCode::Char('=') if !typing => {
                        if let Some(i) = home.0 {
                            a.cur = i;
                        }
                        if let Some(i) = home.1 {
                            b.cur = i;
                        }
                    }
                    code => {
                        let app = if focus_b { &mut b } else { &mut a };
                        if app.key(code) {
                            break Ok(());
                        }
                    }
                }
            }
            Ok(_) => {}
            Err(e) => break Err(e),
        }
    };
    ratatui::restore();
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The source pane colours Solidity by the theme's code tokens.
    #[test]
    fn source_pane_is_syntax_highlighted() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/diff_fixture/a");
        let Ok(mut s) = Session::compile(&root, "test/Counter.t.sol") else { return };
        let run = s.run_test("CounterTest", "test_bumpTwice", false).unwrap();
        let theme = Theme::load("dracula").unwrap();
        let app = App::new(&s, &run.test, "t".into()).with_theme(theme.clone());
        let mut term = ratatui::Terminal::new(ratatui::backend::TestBackend::new(160, 48)).unwrap();
        term.draw(|f| app.draw(f)).unwrap();
        let buf = term.backend().buffer().clone();
        // Find a `function` keyword on screen and check its colour.
        let keyword = theme.code[crate::highlight::CLASSES.iter().position(|c| *c == "keyword").unwrap()];
        let found = (0..48).any(|y| {
            let row: String = (0..160).map(|x| buf[(x, y)].symbol().to_string()).collect();
            row.find("function").is_some_and(|x| buf[(row[..x].chars().count() as u16, y)].fg == keyword)
        });
        assert!(found, "no `function` keyword drawn in the theme's keyword colour");
    }
}
