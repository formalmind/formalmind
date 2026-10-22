# Formal Mind design guide

How Formal Mind looks, reads and moves, for anyone adding UI. It describes what the app already does, so new work
looks like it was always there. When this guide and the code disagree, match the code that is closest to what you are
building and fix this guide in the same change.

One codebase, three places it runs:

| Platform | What | Shell | Entry |
| --- | --- | --- | --- |
| **Mac app** (main focus) | Tauri 2, macOS | `desktop/` | `desktop/src/app.tsx`, `desktop.css` |
| **Website** | formal.team, Vite + React | `src/`, `components/` | `src/app.tsx` |
| **iPhone** | Tauri 2 iOS (a WKWebView, not React Native) | `mobile/` | `mobile/src/app.tsx`, `mobile.css` |

All three import the same `src/globals.css` tokens and the same Tailwind config (`desktop/` and `mobile/` spread
`tailwind.config.ts` and only change `content`). Components are shared through `@/`; most product UI lives in
`desktop/src/swarm-panel.tsx` and is reused by the website.

## 1. Principles

1. **A tool, not a brochure.** Auditors and Solidity developers read code here for hours. Dense, quiet, monochrome;
   the code is the loudest thing on screen.
2. **Colour means status.** The neutral palette carries the layout. Hue only says something: proved, not modeled,
   failed, a role. Never use colour for decoration.
3. **Say exactly what is established.** "Proved" means a finished theorem names the function's Lean model. If a check
   didn't run, say "Not run", never a green tick. Disclaimers are one plain sentence, not a wall.
4. **Everything is a click from the code.** Every function, theorem, finding and file reference links to its line.
5. **Mac-native feel.** Title-bar controls, ⌘ shortcuts, segmented controls, sheets of cards on a muted page. No web
   chrome (no big headers, no hero bars) inside the app.

## 2. Colour

### Neutral tokens

The palette is pure grey (hue 0, saturation 0), shadcn `new-york` on `stone`, defined as HSL triplets in
`src/globals.css` (`:root` light, `.dark` dark). Always use the token utilities, never raw greys:

| Token | Use | Light | Dark |
| --- | --- | --- | --- |
| `background` | The page, editors, rails | 100% | 14% |
| `foreground` | Text | 3.9% | 94% |
| `card` | Cards and panels on the page | 100% | 17% |
| `popover` | Menus, hover cards | 100% | 18% |
| `muted` | Page under cards (`bg-muted/60`–`/80`), selected rows, chips | 96.1% | 21% |
| `muted-foreground` | Secondary text, labels, line numbers (`/60`) | 45.1% | 68% |
| `border`, `input` | Hairlines, field borders | 89.8% | 24% |
| `ring` | Focus ring | 3.9% | 72% |
| `primary` | shadcn Button default (near-black / near-white) | 9% | 94% |
| `destructive` | Destructive buttons only | red | dark red |
| `sidebar-*` | The app sidebar and the Mac title bar (`bg-sidebar`) | 98% | 11% |

`chart-*` exists but is unused. Prefer the status hues below for data.

### Status colours

Every status uses one Tailwind hue in three fixed shapes:

| Shape | Classes |
| --- | --- |
| Dot | `size-2 rounded-full bg-{hue}-500` (`size-1.5` inside text or pills) |
| Text | `text-{hue}-700 dark:text-{hue}-400` |
| Chip / card | `border-{hue}-500/30 bg-{hue}-500/10` (`/5` for a large callout), text as above |

What each hue means. Keep these meanings; don't reuse a hue for something else on the same screen.

| Hue | Proofs (`fnStatus`) | Findings (`STATUS`) | Severity | General |
| --- | --- | --- | --- | --- |
| emerald | Proved | Fixed | n/a | success, on, live |
| sky | Has `sorry` | Works as expected | low | information, partial |
| violet | In Lean, not proved | n/a | n/a | modeled, merged |
| amber | Not modeled | Acknowledged | medium | needs attention, warning |
| red | n/a | Open | high (500), critical (600) | error, failed, running recording |
| muted (`bg-muted-foreground/40`) | n/a | Rejected | n/a | not run, unknown |

Swarm roles have their own hex colours in `lib/swarm-roles.ts` (`ROLE_COLORS`). An agent is its name in its role
colour, with no dot before it.

Other fixed colours:
- **Squiggles:** `.fm-squiggle-error` (#dc2626) and `.fm-squiggle-warning` (#d97706).
- **Code:** Shiki tokens with `--shiki-light` / `--shiki-dark`.
- **Brand accent:** `#7CE3A1` ("Proof"), used on brand assets only, not in app UI.

## 3. Typography

### Fonts

- **Inter** (400–600) for everything: `font-sans`, loaded from Google Fonts in each `index.html`.
- **Instrument Serif** for display moments only: `.font-display`. Use it for empty-state and onboarding headlines,
  the sidebar wordmark "Formal Mind." and the user's name. Never for UI labels or body text.
- **Mono** is Tailwind's default `font-mono` stack, which is SF Mono on the Mac. Use it for code, paths, identifiers,
  counts in tables, and the small uppercase labels.
- `antialiased` is on `body` everywhere. Use `tabular-nums` for numbers that change or line up.

### Scale

The app uses pixel sizes, not `text-sm`/`text-xs`, because the UI is denser than Tailwind's scale. Use these and
nothing in between:

| Size | Line height | Use |
| --- | --- | --- |
| `text-[10px]` | n/a | Mono uppercase sub-section labels, counts in lists, badges |
| `text-[11px]` | `leading-4`/`leading-5` | Toolbar text and buttons, chips, metadata, small code (`FileView`), the panel label |
| `text-[12px]` | `leading-5` | Default UI text in panels: list rows, rail content, menu items, segmented tabs |
| `text-[12.5px]` | `leading-6` | The code editor (`FileView big`, the Lean editor) |
| `text-[13px]` | `leading-5` | Card body text, settings rows, Mac title-bar tabs, the title of a detail pane |
| `text-[15px]` | n/a | iPhone body (iOS reading size) |
| `text-sm` (14px) | n/a | shadcn components (Button, Message, composer) as they come; don't restyle them down |
| `.font-display text-5xl leading-[1.05]` | n/a | Empty-state and onboarding headlines |

Weights: 400 for text and `font-medium` (500) for emphasis, selected tabs, names and buttons. Avoid `font-semibold`
in the app, and never use bold.

### The label

Section and panel names are small mono capitals. The canonical one is `PanelLabel` in `components/panel-card.tsx`:

```tsx
<span className="font-mono text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Lean coverage</span>
```

Sub-sections inside a panel use the smaller form:

```tsx
<p className="px-3 pb-1 pt-3 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Theorems · 9</p>
```

Counts go after a middle dot: `Theorems · 9`, `Plan · asyncswap/contracts`.

## 4. Space, size, shape

### Heights

| Element | Class |
| --- | --- |
| Mac title bar | `h-10` (`desktop/src/tabs.tsx`) |
| Detail card header (`DetailCard`) | `h-10 border-b pl-4 pr-2` |
| Panel card header (`PanelCard`) | `h-9` |
| Panel toolbar and file bar (Code, rails, Lean editor) | `h-8 border-b px-3` (or `px-4` for the file bar) |
| Section header row above a card | `flex h-8 items-center px-1.5`/`px-2.5` + the label |
| Small button, segmented control in panels | `h-6`/`h-7` |
| Icon button | `size-6 rounded-md` in panels, `size-7 rounded-md` in the title bar |
| shadcn Button | `h-9` default, `h-8` sm; reserve for forms and dialogs |

### Radius and elevation

- `rounded-md`: buttons, inputs, list rows, segmented items
- `rounded-lg`: cards nested inside a card (theorem cards, callouts, log blocks)
- `rounded-xl`: cards on the page (`rounded-xl border bg-card`, with `shadow-card` when it floats on `bg-muted`)
- `rounded-2xl`: the `PanelCard` shell, `rounded-2xl border bg-muted/60 p-1.5`, holding an `h-9` header and an
  inner `rounded-xl border bg-card shadow-card`
- `rounded-full`: dots, pills, the theme switch, marketing buttons
- iPhone groups: `rounded-[22px] bg-card shadow-card`
- Shadows: `.shadow-card` (a hairline lift) for cards, `.shadow-pop` for menus and popovers, `shadow-sm` for the
  selected segmented pill. Nothing heavier inside the app.

### Spacing

Panels sit on a muted page with `gap-1`/`p-1` between cards. Inside cards: `px-3 py-2` for rows, `p-3`/`p-4` for
card bodies, `px-6 py-5` for reading content (`DetailCard`). Lists use `p-1` with `rounded-md px-2 py-1` rows.

## 5. Layout patterns

Reuse these before inventing a layout.

**Page under the tabs.** Code, Proofs and Bugs fill the page under the title bar: `absolute inset-x-0 bottom-0
top-[var(--fm-top)] flex min-h-0 flex-col`. Every flex child that scrolls needs `min-h-0` (and `min-w-0` for code).

**File bar.** `flex h-8 shrink-0 items-center gap-2 border-y px-4`: an icon, `Breadcrumbs`, then right-aligned tools
in `ml-auto flex items-center gap-1`. Tools are small toggles like `vim` and **Proofs**: `h-6 rounded-md px-1.5
text-[11px] font-medium`, emerald tint when on (`bg-emerald-500/15 text-emerald-700 dark:text-emerald-400`), muted
with `hover:bg-muted` when off. Then `CopyButton`.

**List + detail.** A `w-72` list card beside a `flex-1` detail card (`CoverageView`, `BugsView`):
- List rows: `flex w-full items-center gap-2 rounded-md px-2 py-1 text-left font-mono text-[12px]`, selected
  `bg-muted text-foreground`, others `text-muted-foreground hover:bg-muted/60 hover:text-foreground`.
- A status dot leads the row; a count trails it.
- Filters are a row of `h-6 rounded-md px-2 text-[11px]` buttons, selected `bg-muted font-medium`.
- On a phone the list stacks above the detail (`max-sm:flex-col`).

**Rail.** A panel beside the code: `w-[min(26rem,42%)] shrink-0 border-l bg-background`, an `h-8` header with the label
and an icon button, then its content. Examples are the Proofs rail beside Solidity and the Lean Infoview.

**Summary strip.** Counts as `mono value + muted unit`, with a thin progress bar on the right: `h-1.5 w-20
rounded-full bg-muted` holding a `bg-emerald-500` fill.

**Segmented control.** Two to four views of the same thing:

```tsx
<span role="tablist" className="inline-flex h-6 items-center rounded-md border bg-muted/60 p-0.5">
  <button role="tab" aria-selected className="h-5 rounded px-2 text-[11px] bg-background font-medium text-foreground shadow-sm">Coverage</button>
  <button role="tab" className="h-5 rounded px-2 text-[11px] text-muted-foreground hover:text-foreground">Semantics</button>
</span>
```

The page-level version is `NavGroup` in the title bar: one sliding pill, `rounded-md bg-background shadow-sm`, with
`transition-[left,width] duration-300 ease-out-quint`.

**States.** Every async view has all four:
- **Loading:** a muted line with a spinner, `Loader2 size-3.5 animate-spin motion-reduce:animate-none`, and what is
  happening ("Building the Lean model from the AST…"). Use skeletons only on the iPhone.
- **Empty:** one muted sentence that says what to do next ("No theorem in this folder names `X` yet.").
- **Error:** a `rounded-lg border border-red-500/30 bg-red-500/5 p-2.5` callout with the cause in mono `text-[11px]`,
  plus a next step when there is one. Report unexpected errors with `reportError` (`lib/report-error.ts`).
- **Partial:** an amber callout (`bg-amber-500/5`) that says plainly what isn't established.

## 6. Components

Use these before writing markup.

| Component | Where | Use it for |
| --- | --- | --- |
| `FileView` | `desktop/src/swarm-panel.tsx` | Any code. Highlighted, numbered, with optional `mark`, `diagnostics`, `gutter` (status-coloured, clickable line numbers) and a `band`. `big` for the editor, default for snippets |
| `DetailCard` | same | A document-like detail pane (bug report, finding) |
| `PanelCard`, `PanelLabel` | `components/panel-card.tsx` | Settings-style grouped cards |
| `CopyButton` | `swarm-panel.tsx` | Copy, which turns into an emerald check for 1.2s |
| `NavGroup` | `swarm-panel.tsx` | Page modes in the title bar |
| `Breadcrumbs` | `swarm-panel.tsx` | File paths in the file bar |
| `DropdownMenu` | `components/ui/dropdown-menu.tsx` | Pickers and menus. Compact: `[&_[role=menuitem]]:py-1 [&_[role=menuitem]]:text-[12px]`, mono items for paths |
| `ChatComposer` | `components/chat-composer.tsx` | Every prompt box |
| `Message`, `Bubble`, `Trace` | `components/ui/` | Chat and agent tool calls |
| `ChatMarkdown` | `components/chat-markdown.tsx` | Rendered Markdown |
| `JsonTree` | `desktop/src/json-tree.tsx` | JSON files |
| `ThemeSwitch` | `components/nav-user.tsx` | The only theme control (light / dark / system) |
| shadcn `ui/*` | `components/ui/` | Avatar, Badge, Card, Collapsible, HoverCard, Input, Progress, Separator, Sheet, Sidebar, Skeleton, Tooltip, … |

Rules for new components:
- **Props over variants:** a component takes data and callbacks (`onOpenFile(path, line)`), not class overrides.
- **Shared views take a `Bridge`:** a view that can run on both the Mac and the web takes `invoke` and lets the host
  provide it. The Mac app supplies Tauri commands; the website supplies `components/projects/git-bridge.ts`.
- **Gate by capability:** use `isTauri()` only for what needs the Mac (`lake serve`, local processes, Neovim).
- **Remember view toggles per viewer:** wrap `localStorage` in try/catch (the `store` helper) with `fm:` keys.
- **Buttons:**
  - **Primary in a panel:** `h-7 rounded-md bg-foreground px-3 text-[12px] font-medium text-background
    hover:bg-foreground/90`.
  - **Tool:** `h-6 rounded-md px-1.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground`.
  - **Marketing and onboarding pills:** `.btn-dark` and `.btn-soft`.
- **Fields in panels:** `h-7 rounded-md border bg-background px-2 text-[11px]` (`font-mono` for paths) with
  `focus-visible:ring-1 focus-visible:ring-ring`.

### Icons

- `lucide-react` for everything. `@primer/octicons-react` only for GitHub concepts: `MarkGithubIcon`, repo, PR,
  issue, merge.
- Sizes: `size-3` in toolbar buttons and inline with 11px text, `size-3.5` in card headers and lists, `size-4` in
  shadcn buttons and the title bar. Use `size-*`, not `h-* w-*`.
- An icon next to text needs `gap-1`/`gap-1.5` and `shrink-0`. An icon-only button needs a `title` and an
  `aria-label`.

## 7. Motion

- No motion library: CSS keyframes in `globals.css`/`mobile.css`, Tailwind transitions and `tailwindcss-animate`.
- **The curve** is `cubic-bezier(0.22, 1, 0.36, 1)` (`ease-out-quint`, `--tabs-ease`). Durations: 150 ms for colour
  and opacity, 250–300 ms for movement, 600 ms only for entrances.
- **Entrances:** `.fm-rise`, staggered with `[animation-delay:80ms|160ms|220ms]`. For a chat message that arrives,
  `.fm-settle`.
- **Loading:** a spinner (`animate-spin`), `.fm-dots`, or `.fm-shimmer`. Use `animate-pulse` only for a live/running
  dot.
- **Reduced motion is required.** Every keyframe class has a `prefers-reduced-motion` override; add one for any new
  class. Add `motion-reduce:animate-none`/`motion-reduce:transition-none` to spinners and moving pills.
- Nothing moves on its own in a working view unless it reports progress.

## 8. Dark mode

`next-themes` with `attribute="class"`, default `system`, key `formal-mind-theme`, wraps all three apps. Tailwind is
`darkMode: ["class"]`.
- Tokens switch on their own, so use tokens and you get dark mode for free.
- Status hues need their `dark:` text variant (`text-emerald-700 dark:text-emerald-400`).
- Check every new view in both themes. In Storybook, use the theme toolbar.
- Some surfaces are always dark by design: Mac onboarding (`bg-[radial-gradient(…#151a24…#08090b…)] text-white`) and
  brand assets. Don't make other surfaces always-dark.

## 9. The Mac app

The window is 1280×820 (minimum 800×560) with `titleBarStyle: "Overlay"` and a hidden title. The traffic lights are at
(18, 22). There is no vibrancy: surfaces are opaque tokens.

**Title bar** (`desktop/src/tabs.tsx`), `h-10 bg-sidebar pl-[84px]`. The 84px clears the traffic lights, so keep
anything clickable to the right of it. In order:
1. Sidebar toggle
2. A hairline divider (`w-px h-4 bg-border`)
3. `#fm-titlebar-slot`: a page puts its controls there with `useTitlebarSlot()` + `createPortal`, as `NavGroup`
   does. When a page fills the slot, its active tab hides.
4. The tabs (`h-7 rounded-lg text-[13px]`, active `bg-background shadow-card`)
5. New tab, Refresh, Settings, the notification bell

Rules:
- **Drag regions:** add `data-tauri-drag-region` to any empty title-bar area, and never put it on a control.
  `.fm-drag` is the 32px strip for full-window pages (onboarding).
- **Shell offset:** `.fm-shell` adds 40px top padding. Full-height things use `h-dvh`, which `desktop.css` corrects.
  Don't hard-code 40px yourself.
- **Shortcuts:**
  - App-wide: ⌘T new tab, ⌘W close tab, ⌘, Settings (native menu "Settings…"), ⌘B sidebar, ⌘S save (Lean editor), ⌘[ / ⌘] back and forward in Code,
    ⌘-click go to definition.
  - In Code with Vim on: `gd` go to definition, `ctrl-o` back.
  - Show each shortcut in the control's `title`: "New tab (⌘T)", "Save (⌘S)".
- **Native menu items** belong in `desktop/src-tauri/src/lib.rs` and emit an event the front end listens for (as
  `fm:settings` does). Use `…` in the label when the item opens something that needs more input.
- **Mac-only features**, gated with `isTauri()`:
  - local folders and the local swarm
  - the debugger
  - Neovim (`vim` in the file bar)
  - the Lean editor (`lake serve`)
  - the SolidCore experiment

  On the web, the same place shows the read-only version or nothing. Never show a disabled Mac feature on the web.
- **Long-running work** reports progress in place (status line, spinner, counts) and lands in the notification bell
  when it finishes. Don't use toasts.
- **Settings** uses grouped `PanelCard`s with the `h-8` mono label rows (`desktop/src/settings.tsx`).

### Proofs in Code (an example to follow)

The proof tools show how a new capability should enter the app (`desktop/docs/proof-workspace.md`):
- **Gutter and rail:** each function's line number in its status colour, and a rail beside the code for the selected function. Mark the existing gutter rather than adding a column.
- **One click each way:** the rail opens the theorem at its line, and the Lean editor's Infoview links back to the
  Solidity function.
- **One toggle:** **Proofs** in the file bar, remembered per viewer.
- **Mac only where it must be:** the Lean editor needs `lake serve`, but the rail works on the web too.
- **Honest labels:** "Doesn't check", "Not run", and one sentence saying what "proved" means.

## 10. The iPhone app

Same tokens and components, iOS-sized:
- **Type and controls:** 15px body text, 44pt touch targets.
- **Safe areas:** `.fm-safe-top`/`.fm-safe-bottom`.
- **Tab bar:** a floating glass tab bar, `.fm-glass rounded-full p-1`, with `size-[21px]` icons (stroke 2.2 when
  active, 1.8 when not).
- **Settings:** `rounded-[22px]` groups with coloured icon tiles and hairlines inset at 60px. Group captions are
  13px uppercase, not mono.
- **Buttons:** primary is `rounded-full bg-white px-4 py-3 text-[15px] font-medium text-neutral-950`.
- **Forms:** use 16px inputs, so iOS doesn't zoom on focus. Switches are `.fm-switch` (iOS green `#34c759`).
- **Loading:** skeletons (`.fm-skeleton`) and `.fm-think-dot`, rather than spinners.

See `mobile/README.md` for the shell.

## 11. The website

The app pages on formal.team are the same components as the Mac app. The marketing pages (landing, sign-in,
onboarding) may use:
- `.font-display` headlines
- `.btn-dark`/`.btn-soft` pills
- `fm-rise` entrances and larger type

The pre-paint theme script in `index.html` prevents a flash; keep it.

## 12. Words

- **Name:** **Formal Mind**, two words, in the UI. The serif wordmark is "Formal Mind." with a period. The lowercase
  `formalmind` is only for handles, URLs and the brand lockup.
- **Sentence case** everywhere: "Add a project", "Set up agents later", "Open in Code".
- **Plain verbs** on buttons ("Run", "Save", "Open"), no "Click here".
- **Punctuation:**
  - `…` (one character) for ongoing states and for menu items that ask for more ("Settings…", "Checking…").
  - ` · ` to join facts ("public nonpayable · lines 526–529").
  - An en dash for ranges.
- **Errors** say what happened and what to do: "Couldn't reach the server; try again." Write "Couldn't", not "Failed
  to", and don't blame the user.
- **Empty states:** "No … yet." plus the next step.
- **No exclamation marks.** "Thanks!" after a payment is the one exception.
- **Claims:** state exactly what was checked, never more. Write "Lean checks the theorem; it doesn't check the model
  against the bytecode", not "Verified".
- **Code comments** use the same plain voice and say why, not what.

## 13. Accessibility

- **Labels:** every icon-only button gets a `title` and an `aria-label`. Toggles use `aria-pressed`; tabs use
  `role="tab"` with `aria-selected`; disclosure rows use `aria-expanded`.
- **Status text:** status updates that change while you watch go in an `aria-live="polite"` region (the Lean editor's
  status line).
- **Focus:** keep it visible (`focus-visible:ring-1 focus-visible:ring-ring`), and never remove outlines without a
  replacement.
- **Colour is never the only signal:** a dot always has a `title` or a text label next to it.
- **Contrast:** use the `-700` text shades in light mode and `-400` in dark. Muted text stays on `background`/`card`,
  not on `muted`.
- **Reduced motion:** see §7.

## 14. Storybook

`bun run storybook` (port 6006); `bun run build-storybook` builds a static copy. Stories live in
`stories/*.stories.tsx` and are titled by area: `Swarm/Canvas`, `Desktop/Settings`, `Home/Empty`, ….

- `.storybook/preview.tsx` loads `src/globals.css` and wraps every story in a `MemoryRouter`. Set the start URL with
  `parameters.route`.
- It adds the light/dark switcher (`withThemeByClassName`).
- Network calls are mocked with `withMockFetch(routes)` from `stories/mock-fetch.tsx` (`json()`, and `chatStream()`
  for an AI SDK stream). Fixtures live in `stories/fixtures/`.
- Write a story for each state from §5: loading, empty, error and a realistic full one. Use real-looking data from
  `asyncswap/contracts`, not lorem ipsum.
- For a component that takes a `Bridge`, pass an `invoke` that answers from fixtures. That also covers Mac-only views
  on the web Storybook.

## 15. Before you open the PR

- [ ] Tokens only: no raw greys, no hex outside `ROLE_COLORS`/brand.
- [ ] Sizes from §3 and heights from §4; mono labels for sections.
- [ ] Status colours mean what §2 says; every dot has a label or title.
- [ ] Loading, empty, error (and partial) states exist.
- [ ] Checked in light and dark, at 800px wide (the Mac minimum) and on a phone if it's shared.
- [ ] Reduced motion handled for anything that moves.
- [ ] Mac-only features gated with `isTauri()`; the web shows the read-only version or nothing.
- [ ] Shortcuts in `title`s; icon buttons labelled.
- [ ] Copy in sentence case, says exactly what's established.
- [ ] A story for a new shared component; `bunx tsc --noEmit -p .` and `bun run build` pass.

## 16. Known gaps

Fix these when you are in the area:
- `chart-*` tokens and the `.fm-folder*` classes are defined but unused.
- `Trace`'s running style uses a `shimmer` utility that isn't defined.
- Some older components use `h-3.5 w-3.5` instead of `size-3.5`, and `text-sm`/`text-xs` where the scale in §3
  applies.
- The Mac and iPhone `index.html` files have no pre-paint theme script, so a dark-mode user can see one light frame
  on launch.
- The Mac title bar's `.fm-titlebar` and `<html class="fm-desktop">` have no CSS. They are hooks for Mac-only styles
  when needed.
