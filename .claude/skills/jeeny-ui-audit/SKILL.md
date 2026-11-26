---
name: jeeny-ui-audit
description: Manual, report-only UI audit for Jeeny INSIDE. Checks the implemented Student App, Driver Mode and Operations Dashboard against product rules, user decisions, accessibility and consistency, using the design-reference hierarchy in section 2 (original Jeeny app primary, Google Stitch optional and secondary) and references/tokens.md, and reports findings with IDs. Audit Mode is read-only and is the default. Fix Mode applies only finding IDs the user explicitly approves after reading a report. Invoke with /jeeny-ui-audit student | driver | ops | all, or /jeeny-ui-audit fix <IDs>.
argument-hint: "student | driver | ops | all | fix <finding IDs>"
disable-model-invocation: true
allowed-tools: Read, Grep, Glob
---

# Jeeny UI Audit

Arguments: `$ARGUMENTS`

A design-consistency audit for the Jeeny INSIDE web app (React + Vite + TypeScript + Tailwind v4, one app with `/student`, `/driver` and `/ops` route areas). It finds where the implementation breaks product rules, user decisions, accessibility or cross-area consistency, notes where it differs from the design references in section 2, and reports it. It never redesigns.

This file must be followable by a session that has no memory of how it was written. Read it in full before doing anything.

## 0. Choose the mode

| Arguments | Mode |
|---|---|
| empty, `all` | Audit Mode, all areas |
| `student`, `driver`, `ops` | Audit Mode, that area (plus the shared UI it uses) |
| `ui` | Audit Mode, shared UI only (`client/src/ui/**`, `client/src/styles.css`, `client/src/routes/AreaLayout.tsx`) |
| `fix` followed by one or more finding IDs | Fix Mode, only if section 5's entry conditions are met |
| anything else | Ask what the user wants. Do nothing else |

**Audit Mode is the default.** If there is any doubt about the mode, use Audit Mode.

## 1. Non-negotiable rules (both modes)

1. **Manual only.** This skill runs only when the user invokes it. Never start it, or Fix Mode, on your own.
2. **No git actions.** Never commit, push, create or switch branches, stash, reset, rebase, open a pull request or comment on one.
3. **Never touch application behavior.** Out of scope, never edited or proposed as edits: `server/**`, `engine/**`, `shared/**`, `campus/**`, `client/src/lib/**` (API clients, realtime store, booking, ride and Tap-In logic), `scripts/**`, `package.json`, `package-lock.json`, `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, the database and its files, routes and URLs, REST endpoints and payloads, Socket.IO events, the ride lifecycle and statuses, fare and loyalty calculations, Ghost Ride rules, NFC Tap-In rules, campus data, test files (`*.test.ts`, `*.test.tsx`).
4. **No new dependencies.** Never propose or add an npm package, CDN script, external font service (Google Fonts included), icon library (Material Symbols included), CSS framework, or another skill. Never install StageShow. Work only with Tailwind v4 utilities and the `@theme` tokens in `client/src/styles.css`.
5. **Data integrity.** Never fabricate data, metrics, statuses or features. Keep every integrity label: "Sample data", "Demo data", "Simulated", "Simulated fare", "not verified", "Unavailable". Never present simulated information as live, never turn an unavailable value into 0 or a dash that reads as zero, never shrink an integrity label below 13px or hide it. Never infer that the backend supports something because a Stitch screen or a presentation shows it.
6. **Brand.** Jeeny INSIDE identity only. No palette, typography or visual identity is approved until the user approves it (section 2.3). No official Jeeny logos or assets, no imitation of the official Jeeny logo, no other product's look, no copying external designs. A value missing from `references/tokens.md` is reported as "Token missing", never invented.
7. **Student App.** The Student App is approved and is not redesigned. See section 3.
8. **Honesty.** Never claim to have looked at rendered output, screenshots or a running app unless you actually did in this session. Never claim a command, test or build passed unless you ran it and saw it pass. Say "not verified" when something was not checked.
9. **No silent scope growth.** Do only what the mode and the user's words cover. If something useful falls outside, list it under "Out of scope / needs a decision" and leave it.

## 2. Design reference authority

### 2.1 What governs, in order

1. **Explicit user decisions.** Only what the user has explicitly approved. Nothing is approved by being suggested earlier, by appearing in a reference, or by being written in `references/tokens.md`.
2. **Existing product behavior and business rules**: the code and server (ride lifecycle and statuses, Tap-In, Ghost Ride, fare, data sources) and the Foundation Plan product rules (integrity labels, simulated fare, no official Jeeny assets). They always take precedence over visual references.
3. **Existing implementation constraints**: rules 3 and 4, the protected areas (section 3), the **Unresolved** list U-1 to U-11 in `references/tokens.md` (reported as "Blocked by U-n", never decided by you), the approved Student App as the reference for how patterns behave in the real app (see U-3 for its visuals), and the existing shared components in `client/src/ui/`: `PrimaryButton`, `IconButton`, `Badge`, `Card`, `BrandMark`, `BrandLockup`, `CampusMap`, `MapLegend`, and the frame `client/src/routes/AreaLayout.tsx`.

### 2.2 Design references (inspiration and context, never authority)

**Primary references**
- **The original Jeeny app video**: the primary reference for rider UX patterns and interaction principles.
- **The original Jeeny presentation materials**: supporting references for brand context, visual direction and product positioning. Not every visual element or claim in them represents the current Jeeny INSIDE product.

**Secondary references**
- **The three newer Stitch concept screens** (Student, Driver, Operations): optional visual inspiration for consistency across the three areas.
- **The older Stitch exports** (three zip files: Student App 18 screens, Driver Mode 9, Operations Dashboard 11): historical archive only.

Stitch screens are never copied literally and are not the frontend implementation baseline. None of these materials is in the repository. If an audit needs one, ask the user for its location unless they gave it; if it cannot be obtained, say so at the top of the report and mark those comparisons "not verified". For the archived exports, extract only into a temporary directory outside the repository (never into the repo), verify each HTML file against its `manifest.json` SHA-256 when possible, compare the zip SHA-256 with the values in `references/tokens.md`, report any mismatch, and read the exported **HTML and its embedded Tailwind config**, not only screenshots.

### 2.3 Design authority rules

- No color palette is approved until the user explicitly approves it.
- No typography or font choice is approved until the user explicitly approves it.
- No component styling or visual identity proposal becomes authoritative without user approval.
- Do not treat any previously suggested palette, font or design direction as approved, including the values in `references/tokens.md`.
- Existing product behavior and business rules take precedence over visual references.
- Never introduce fake data, fake functionality, unsupported AI claims or misleading live-status indicators to match a reference.
- When a reference conflicts with actual product behavior, report the conflict instead of copying the reference.
- When design authority is unclear, report the ambiguity and request a decision rather than inventing one.

A difference between the code and a design reference is reported for information (or as "needs a decision"), never by itself as a defect. Defects come from product rules, user decisions, accessibility, integrity, broken layout and inconsistency across areas.

### 2.4 `references/tokens.md`

It records the values measured from the archived Stitch exports, the Code vs Stitch table and the Unresolved list. Its values are a measurement record, not approved values. Stitch pages use Tailwind v3 class names with a custom config (for example its `rounded-xl` is 24px); the app uses Tailwind v4. When comparing with a reference, **compare by value** (hex, px, weight), never by class name.

## 3. Protected areas

- **Student App** (`client/src/student/**`, `client/src/routes/StudentHome.tsx`, the Student flow in `client/src/tap/**`): findings go in "Student: for information only". Until the user resolves U-3, report Student divergences from Stitch as information and propose **no** Student visual change. Real defects (overflow or broken layout at 360 to 430px, missing accessible name, missing focus indication, contrast below WCAG AA, a missing integrity label) are reported with severity, and their proposed correction must not alter the approved look.
- **Shared UI** (`client/src/ui/**`, `client/src/styles.css`, `client/src/routes/AreaLayout.tsx`, `client/src/routes/PersonaPicker.tsx`): used by Student. Every finding there is marked "Affects Student: yes", and its proposed correction must leave Student rendering unchanged (an additive variant, an opt-in prop, or a new token used only by Driver and Ops; never a changed default).
- **Driver Mode** (`client/src/driver/**`, `client/src/routes/DriverHome.tsx`) and **Operations Dashboard** (`client/src/ops/**`, `client/src/routes/OpsHome.tsx`): must share one identity with Student (once the user approves it), keeping their role-specific layouts and workflows. Their Stitch screens are optional inspiration only (section 2.2).
- **Screens in Stitch with no implementation** (for example Campus Copilot, Campus Pulse, Campus Impact, Priority/SOS, Profile, Battery Rescue, Campus Intelligence): report once under "Design without implementation". They are not defects, and building them is out of scope.

## 4. Audit Mode (default, read-only)

### 4.1 Read-only means

- Do not create, edit, move or delete any file in the repository. Use Read, Grep and Glob. If you need a shell (for example to unzip the exports into a temporary directory or to compute a hash), only read or write outside the repository, and never run installs, formatters, builds, dev servers or tests that write files.
- Visual inspection is optional and only with the user's permission: if a browser tool is already available and the user agrees, view the running app at 360, 390 and 430px wide for Student and Driver, and 768, 1024, 1280 and 1440px wide for Ops. Save nothing into the repository. If you did not inspect rendered output, say "Visual check: not done".
- Never fix anything in Audit Mode, even a one-character typo.

### 4.2 Procedure

1. Confirm scope and sources: area, which design references are available and where (section 2.2), whether a visual check is allowed. Record the current branch and HEAD (read-only `git` status commands are allowed), so the report is tied to a code version.
2. Read `references/tokens.md` and `client/src/styles.css`.
3. If design references are available, pair each screen in scope with its reference screen(s) for information (list the pairing in the report; a screen with no counterpart is said to have none). When a Stitch screen is used, read its HTML for components (`data-component-id`), text tokens (`data-design-text-token`), colors, spacing, radius, borders, shadows, states and navigation.
4. Audit the implementation (skip test files) against the checklist in 4.3.
5. Write the report (4.5). Then stop and wait. Do not offer to "just fix" anything.

### 4.3 Checklist

**Color.** Every color resolves to a token in the `@theme` block of `client/src/styles.css` (the current implementation tokens, not an approved palette). Differences from the reference values in `references/tokens.md` are reported for information until the user approves a palette. The primary color only for primary actions, active navigation, links and brand marks. Teal for secondary highlights only. Status meaning is the same in every area: success = completed / available, error = cancelled / failed / SOS, warning = stale / low battery / caution, neutral chip = demo or inactive. Flag raw hex in TSX and off-token Tailwind palette colors.

**Typography.** No type scale or font is approved yet; differences from the reference scale in `references/tokens.md` (13 to 36px) are reported for information. Flag text under 13px. The same role (screen title, card title, row title, label, caption, fare, ID) must use the same token in every area. Numbers, IDs, times and fares use the mono role and `tabular-nums`. Font family differences are "Blocked by U-1".

**Spacing and layout.** The same role uses the same spacing in every area; the reference gutters in `references/tokens.md` (4, 8, 12, 16, 24, 28px) are informational. Page gutter 16px on mobile. Student and Driver are single-column, max 448px wide. Ops is responsive (the archived Stitch frame, sidebar from 1024px and stacked below, is informational). No horizontal page scroll at 360px; wide Ops tables scroll inside their own container. Touch targets at least 44 × 44px on Student and Driver.

**Shape and surface.** The same element type uses the same radius, border and shadow in every area. The reference values in `references/tokens.md` (cards 24px, link cards 16px, fields and inner rows 12px, chips and buttons fully round, card border and shadow) are informational. No gradients.

**Components.** The shared components in `client/src/ui/` are used instead of hand-built lookalikes, and buttons, icon buttons, cards, badges, chips, inputs and tables are styled consistently across areas. The Stitch component specs in `references/tokens.md` are informational. One primary action per screen or card. Driver action button height: see U-8.

**Navigation.** Compare with the reference navigation for the area for information, but see U-5: never propose a link to a screen that does not exist. Student: the five-tab direction (Home, Quick, My Rides, Campus Map, Profile) is approved as a structure only; report each tab as implemented or planned (awaiting implementation) per U-5, never a planned one as working.

**States.** Loading, empty, offline, error and stale-data states exist where data loads and follow one consistent pattern across areas (the archived Stitch state screens `app-states`, `driver-states`, `dashboard-states` are informational), with `role="status"` or `role="alert"`.

**Integrity.** Every integrity label in rule 5 is present where it applies and readable. "Unavailable" is never replaced by 0. The fare keeps "Simulated fare" (U-6).

**Workflow fidelity.** The UI must show only what the real ride lifecycle supports: statuses, actions and their order come from the existing code and server, not from Stitch or the presentations. Flag a visual element that implies a capability the app does not have (for example live GPS, ETAs where no API provides them, AI where there is none).

**Accessibility.** Visible keyboard focus on every interactive element (reference: outline 2px, offset 2px, primary; see U-7). Accessible names on icon-only controls. `aria-current` on the active nav item. Contrast at least 4.5:1 for text under 18px (and 3:1 for large text and UI boundaries). `prefers-reduced-motion` respected for anything beyond color transitions.

**Motion.** Color and hover transitions 120ms ease-out; surface enter 240ms and exit 160ms with the reference curves in `references/tokens.md` (informational until approved). No new animation library.

**Regression.** Anything that previously worked visually and now looks broken (overlapping, clipped or invisible content, a lost state) is a finding even if no token is involved.

### 4.4 Finding format and severity

Each finding has:

- **ID:** area prefix and a number, unique in the report: `S-` Student, `D-` Driver, `O-` Ops, `UI-` shared UI (for example `D-03`, `UI-02`). `U-1` to `U-11` are reserved for the Unresolved list in `references/tokens.md` and are never finding IDs.
- **Severity:** Critical, High, Medium or Low.
  - **Critical:** the UI misrepresents data or the workflow (simulated shown as live, unavailable shown as 0, a missing integrity label on a fare or simulated item), or a primary task cannot be completed (control hidden, unreachable or unusable at a supported width).
  - **High:** accessibility failure (no focus indication, no accessible name, contrast below AA), broken layout or overflow at a supported width, a status shown with the wrong meaning or color.
  - **Medium:** off-token color, type, spacing, radius, border or shadow; a hand-built lookalike of a shared component; the same pattern styled differently across areas.
  - **Low:** polish (tabular numbers, small alignment, icon size).
- **Area**, **file path** and **line number** (or the closest code location).
- **Observed:** what the code does now.
- **Reference:** the product rule, user decision, accessibility requirement or implementation token it should match. A design reference (section 2.2) may be cited as context, but is never by itself the reason something is a defect.
- **Why it matters.**
- **Proposed minimal correction:** the smallest class-level change in the named file. If the correction needs a file or change outside UI scope, write "Out of scope: needs <what>" instead.
- **Evidence type:** `Verified` (seen in code or in a reference file), `Inference` (reasoned from code, not seen rendered), `Assumption` (depends on something not confirmed), or `Not verified` (could not be checked; say why).
- **Affects Student:** yes / no.

### 4.5 Report format

```
# Jeeny UI Audit — <scope> — <date>
Code: branch <name>, HEAD <short sha>, working tree <clean | has changes>
Design references: <which were used (Jeeny video, presentations, Stitch concept screens, Stitch archive) and where / not available>; archive hashes <match | mismatch: ... | not checked>
Visual check: <not done | done at widths ... with ...>
Screen pairing: <implementation file → reference screen, or "none">

## Summary
<counts by severity; the most important findings in one line each>

## Findings
| ID | Severity | Area | File:line | Observed | Reference | Why it matters | Proposed minimal correction | Evidence | Affects Student |

## Student: for information only
## Blocked by unresolved decisions (U-1 … U-11)
## Reference conflicts and unclear authority
## Design without implementation
## Out of scope / needs a decision
## Not verified

## Next step
Audit Mode made no changes. To apply fixes, reply with the exact finding IDs, for example:
/jeeny-ui-audit fix D-03 O-07
```

## 5. Fix Mode (only for approved finding IDs)

### 5.1 Entry conditions (all required)

1. A report from this skill exists **in the current conversation**, or the user pastes one, and it contains the IDs.
2. The user explicitly names the individual finding IDs to fix (for example "fix D-03 and O-07" or `/jeeny-ui-audit fix D-03 O-07`). "Fix everything", "fix all High", "go ahead", "looks good" or similar are **not** approval: ask the user to list the IDs.
3. No named finding is a Student visual change while U-3 is unresolved, is marked out of scope, or is blocked by an unresolved item. If one is, say so and do not fix it.

If any condition fails, stay in Audit Mode and explain what is missing.

### 5.2 Before editing

- Re-read the current code at each finding's location; if it changed since the report, re-check the finding and say what changed.
- For each approved ID, state the exact file(s) and the class-level change you will make. Only files named in those findings are edited. If a fix turns out to need any other file, or anything listed in rule 3, **stop** and explain instead of proceeding.
- Grep the test files for any text, label, role or test id the change could affect; never change something a test relies on.

### 5.3 While editing

- Fix only the approved IDs, with the smallest UI-only change. No refactoring, renaming, reformatting, cleanup or "while I'm here" changes.
- Preserve behavior: event handlers, props passed to logic, conditional rendering, data shown, API calls, socket usage, routing and DOM structure that tests or users depend on stay the same.
- Shared UI fixes must leave Student rendering unchanged (section 3).
- No new dependencies, fonts, icon sets or files outside `client/src/**` UI files and `client/src/styles.css`.

### 5.4 After editing

- Report: each ID addressed, each file modified with what changed, and any approved ID not fixed and why.
- Offer to run `npm run typecheck` and `npm test` (and a visual check if available). Report the real outcome: passed, failed (with the relevant output), or not run. Never claim a pass you did not see.
- Do not commit, push or open a pull request. The user does that separately if they want.

## 6. Credits

Audit structure (scan, diagnose, report before fixing, design values kept in one reference file) adapted from `redesign-existing-projects` by Elaya (MIT), which credits taste-skill by Leon Lin (MIT). The reference values in `references/tokens.md` are Jeeny INSIDE's own, extracted from its archived Stitch exports. See `NOTICE.md`.
