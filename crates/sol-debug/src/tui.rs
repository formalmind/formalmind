//! The terminal debugger: source, opcodes, stack, memory, storage and calls for one recorded run, with vim keys.
//!
//!   j / k      next / previous opcode          s / S   step into / back
//!   n / N      next / previous line (over)     f / F   step out / back to the call
//!   c / C      continue to breakpoint, watch or revert (forward / back)
//!   g / G      first / last step               /text   search source lines (then ; and , for next / previous)
//!   :b 58  :b File.sol:58   line breakpoint    :w name  break on storage writes naming it
//!   :pc 1621   jump to that pc in this frame   :step 1200  jump to a step     :q  quit

use crate::nav::{Dir, Navigator};
use crate::session::{short_word, Run, Session};
use crate::srcmap::Jump;
use crate::trace::StorageAccess;
use ratatui::crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use ratatui::layout::{Constraint, Layout, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Paragraph};
use ratatui::Frame;
use revm::bytecode::opcode::OpCode;

pub struct App<'a> {
    s: &'a Session,
    run: &'a Run,
    title: String,
    nav: Navigator,
    cur: usize,
    /// The `:` or `/` line being typed.
    input: Option<String>,
    last_search: Option<String>,
    status: String,
}

impl<'a> App<'a> {
    pub fn new(s: &'a Session, run: &'a Run, title: String) -> Self {
        let nav = Navigator::new(s, run);
        // Open on the first step with source.
        let cur = (0..nav.len()).find(|&i| nav.locs[i].is_some()).unwrap_or(0);
        let verdict = if run.success { "ok".to_string() } else { format!("reverted: {}", run.revert_reason().unwrap_or_default()) };
        App { s, run, title, nav, cur, input: None, last_search: None, status: verdict }
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
    fn key(&mut self, code: KeyCode) -> bool {
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
        let [header, body, footer] = Layout::vertical([Constraint::Length(2), Constraint::Min(10), Constraint::Length(2)]).areas(f.area());
        let [top, bottom] = Layout::vertical([Constraint::Percentage(55), Constraint::Percentage(45)]).areas(body);
        let [source, calls] = Layout::horizontal([Constraint::Percentage(62), Constraint::Percentage(38)]).areas(top);
        let [ops, stack, memory, storage] = Layout::horizontal([
            Constraint::Percentage(24),
            Constraint::Percentage(22),
            Constraint::Percentage(24),
            Constraint::Percentage(30),
        ])
        .areas(bottom);
        self.draw_header(f, header);
        self.draw_source(f, source);
        self.draw_calls(f, calls);
        self.draw_ops(f, ops);
        self.draw_stack(f, stack);
        self.draw_memory(f, memory);
        self.draw_storage(f, storage);
        self.draw_footer(f, footer);
    }

    fn draw_header(&self, f: &mut Frame, area: Rect) {
        let st = &self.run.trace.steps[self.cur];
        let loc = &self.nav.locs[self.cur];
        let place = loc.as_ref().map(|l| format!("{}:{}  {}", l.file, l.line, l.scope)).unwrap_or("<no source>".into());
        let op = OpCode::new(st.op).map(|o| o.as_str()).unwrap_or("INVALID");
        let line1 = Line::from(vec![
            Span::styled(format!(" {} ", self.title), Style::new().add_modifier(Modifier::BOLD | Modifier::REVERSED)),
            Span::raw(format!("  step {}/{}  depth {}  pc {}  {op}  gas {}", self.cur, self.nav.len() - 1, st.depth, st.pc, st.gas_left)),
        ]);
        let line2 = Line::from(vec![Span::styled(format!(" {place}"), Style::new().fg(Color::Cyan)), Span::raw(format!("   {}", loc.as_ref().map(|l| l.node_type.as_str()).unwrap_or("")))]);
        f.render_widget(Paragraph::new(vec![line1, line2]), area);
    }

    fn draw_source(&self, f: &mut Frame, area: Rect) {
        let loc = self.nav.locs[self.cur].as_ref().or_else(|| (0..self.cur).rev().find_map(|i| self.nav.locs[i].as_ref()));
        let Some(loc) = loc else {
            f.render_widget(Paragraph::new("no source for this step").block(Block::bordered().title(" source ")), area);
            return;
        };
        let file = &self.s.sources.files[&loc.entry.file];
        let height = area.height.saturating_sub(2) as usize;
        let first = loc.line.saturating_sub(height / 2).max(1);
        let exact = self.nav.locs[self.cur].is_some();
        let (start, end) = (loc.entry.start as usize, (loc.entry.start + loc.entry.length) as usize);
        let mut lines = Vec::new();
        for n in first..(first + height).min(file.line_count() + 1) {
            let text = file.line_text(n);
            let bp = if self.nav.breakpoints.contains(&(file.id, n)) { "●" } else { " " };
            let gutter = Span::styled(format!("{bp}{n:>5} "), Style::new().fg(if n == loc.line { Color::Yellow } else { Color::DarkGray }));
            if n != loc.line {
                lines.push(Line::from(vec![gutter, Span::raw(text.to_string())]));
                continue;
            }
            // Highlight the part of the line that is the current node's src.
            let line_start = (0..start).rev().find(|&i| file.text.as_bytes().get(i) == Some(&b'\n')).map(|i| i + 1).unwrap_or(0);
            let a = start.saturating_sub(line_start).min(text.len());
            let b = end.saturating_sub(line_start).min(text.len()).max(a);
            let (pre, mid, post) = (text.get(..a).unwrap_or(""), text.get(a..b).unwrap_or(""), text.get(b..).unwrap_or(""));
            let base = Style::new().bg(Color::Rgb(40, 40, 60));
            let node = if exact { base.fg(Color::Yellow).add_modifier(Modifier::BOLD) } else { base.fg(Color::Gray) };
            lines.push(Line::from(vec![gutter, Span::styled(pre.to_string(), base), Span::styled(mid.to_string(), node), Span::styled(post.to_string(), base)]));
        }
        let title = format!(" {} ", file.name);
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(title)), area);
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
                Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD)
            } else if is_open {
                Style::new().fg(Color::White)
            } else {
                Style::new().fg(Color::DarkGray)
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
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(" calls ")), area);
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
                    let style = if pc == st.pc { Style::new().fg(Color::Black).bg(Color::Yellow) } else { Style::new() };
                    lines.push(Line::styled(text, style));
                }
            }
            None => lines.push(Line::raw("code not from this compile")),
        }
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(" opcodes ")), area);
    }

    fn draw_stack(&self, f: &mut Frame, area: Rect) {
        let st = &self.run.trace.steps[self.cur];
        let lines: Vec<Line> = st
            .stack
            .iter()
            .rev()
            .enumerate()
            .take(area.height.saturating_sub(2) as usize)
            .map(|(i, v)| Line::from(vec![Span::styled(format!("{i:>2} "), Style::new().fg(Color::DarkGray)), Span::raw(short_word(*v))]))
            .collect();
        let title = match st.result {
            Some(r) => format!(" stack · result {} ", short_word(r)),
            None => " stack ".into(),
        };
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(title)), area);
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
            let style = if fresh.contains(&off) { Style::new().fg(Color::Yellow) } else { Style::new() };
            let label = if off == 0x40 { "fp" } else { "  " };
            lines.push(Line::from(vec![
                Span::styled(format!("{off:>4x}{label} "), Style::new().fg(Color::DarkGray)),
                Span::styled(shorten_mid(&hex, area.width.saturating_sub(10) as usize), style),
            ]));
        }
        let height = area.height.saturating_sub(2) as usize;
        let skip = lines.len().saturating_sub(height).min(fresh.first().map(|o| o / 32).unwrap_or(0).saturating_sub(height / 2));
        let lines: Vec<Line> = lines.into_iter().skip(skip).collect();
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(format!(" memory · {} bytes ", st.memory_size))), area);
    }

    fn draw_storage(&self, f: &mut Frame, area: Rect) {
        let steps = &self.run.trace.steps;
        let height = area.height.saturating_sub(2) as usize;
        let mut lines = Vec::new();
        // The latest accesses up to this step, newest first.
        for i in (0..=self.cur).rev() {
            let (Some(text), Some(access)) = (&self.nav.storage[i], &steps[i].storage) else { continue };
            let color = match access {
                StorageAccess::Write { .. } => Color::Magenta,
                StorageAccess::Read { .. } => Color::Gray,
            };
            let style = if i == self.cur { Style::new().fg(color).add_modifier(Modifier::BOLD | Modifier::REVERSED) } else { Style::new().fg(color) };
            let who = self.s.name_of(steps[i].address);
            lines.push(Line::styled(shorten(&compact_hex(&format!("{who}: {text}")), area.width.saturating_sub(2) as usize), style));
            if lines.len() >= height {
                break;
            }
        }
        f.render_widget(Paragraph::new(lines).block(Block::bordered().title(" storage (newest first) ")), area);
    }

    fn draw_footer(&self, f: &mut Frame, area: Rect) {
        let help = "j/k op  n/N line  s/S into  f/F out  c/C continue  g/G ends  /search ;,  :b line  :w var  :pc n  :q";
        let second = match &self.input {
            Some(i) => Line::styled(i.clone(), Style::new().fg(Color::White).add_modifier(Modifier::BOLD)),
            None => Line::styled(self.status.clone(), Style::new().fg(Color::Cyan)),
        };
        f.render_widget(Paragraph::new(vec![Line::styled(help, Style::new().fg(Color::DarkGray)), second]).block(Block::new().borders(Borders::NONE)), area);
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
