# Jeeny INSIDE design tokens (audit reference)

**Status: measurement record of the archived Google Stitch exports, not approved values.** The Stitch exports are a secondary, historical reference (see `SKILL.md` section 2): the original Jeeny app is the primary UX reference, and no palette, typography or visual identity is approved until the user explicitly approves it. Values below were read from the exported HTML of all 38 screens, not from screenshots. Where the current code (`client/src/styles.css`, tokens v0) differs from Stitch, the difference is listed under "Code vs Stitch" for information; it is not by itself a defect. Every Stitch-derived value in this file (colors, fonts, sizes, spacing, radii, shadows, component specs, motion, focus style, button heights) is a **historical measurement from the archived Stitch exports: informational only, not an approved design token, and not a mandatory implementation value.** Wherever this file says "reference", it means such an informational value. Items that could not be settled are listed under "Unresolved"; never invent a value for them.

## Provenance

| Export | File (as supplied) | SHA-256 of the zip | Screens |
|---|---|---|---|
| Student App (archived; formerly the primary reference) | `Jeeny_INSIDE_Student_App_COMPLETE_18_SCREENS.zip` | `8c16256a41f0006a4fe88374ff78c0e360ea4800d91e2838209a162c9a7546dc` | 18 |
| Driver Mode | `Jeeny_INSIDE_Driver_Mode_COMPLETE_9_SCREENS.zip` | `cb2c401a395d79ced530885c24968be06617c4b939679219033012a81afb317b` | 9 |
| Operations Dashboard | `Jeeny_INSIDE_Operations_Dashboard_Stitch_Export.zip` | `fe42c84bca40811a44a1d58530a4c4e7ef7a0f0ab3731d143be6aa077da1eb2e` | 11 |

Every HTML file matched the SHA-256 in its export's `manifest.json` when this file was written (38 of 38). All 38 screens embed the **identical** Tailwind config (one design system for all three areas). The exports are **not stored in the repository**; the user supplies them when an audit needs them.

Screens:
- **Student:** student-home, quick-actions, location-selection, ride-booking, finding-a-cart, request-received, ride-tracking, ride-completed, ride-cancelled, my-rides, campus-map, nfc-tap-in, campus-pulse, campus-impact, campus-copilot, priority-mobility-sos, profile, app-states.
- **Driver:** driver-home, waiting-for-assignment, active-trip, pickup-boarding, passenger-list, drop-off, trip-completed, cart-status, driver-states.
- **Ops:** operations-overview, fleet-monitoring, ride-requests, active-trips, trip-details-trp-1082, cart-details-c-04, ghost-ride-monitoring, campus-map-operations, battery-rescue, campus-intelligence, dashboard-states.

Stitch builds pages with the Tailwind v3 Play CDN and a `light-*` / `dark-*` color set. Only `light-*` is used (0 `dark:` classes in 38 screens), so **the design is light theme only**. The app uses Tailwind v4 with `@theme` in CSS: compare by **value** (hex, px), not by class name.

## Colors (light theme, used)

| Stitch token | Hex | Role in the exports |
|---|---|---|
| `light-primary` | #9C0051 | Brand: primary buttons, active nav item, links, fare chip text, brand square |
| `light-on-primary` | #FFFFFF | Text and icons on primary |
| `light-primary-container` | #C8006A | Primary button hover |
| `light-on-primary-container` | #FFDCE4 | Text on primary-container |
| `light-secondary` | #006A63 | Teal accent: campus chip icon, secondary highlights |
| `light-secondary-container` | #99EFE5 | Pickup marker circle, teal chips |
| `light-on-secondary-container` | #006F67 | Text on secondary-container |
| `light-tertiary` | #593F8D | Purple (rare; drop-off and AI contexts) |
| `light-tertiary-container` | #7257A8 | Purple container (rare) |
| `light-error` | #BF0715 | Errors, SOS, cancelled |
| `light-error-container` | #FFDAD6 | Error badge and banner background |
| `light-on-error-container` | #93000B | Text on error-container |
| `light-warning` | #904D00 | Caution |
| `light-warning-container` | #FFDCC3 | Warning badge background (stale data, low battery) |
| `light-on-warning-container` | #2F1500 | Text on warning-container |
| `light-success` | #006A61 | Success (teal-green, not bright green) |
| `light-success-container` | #73F8E7 | Success badge background |
| `light-on-success-container` | #00201D | Text on success-container |
| `light-background` / `light-surface` / `light-surface-bright` | #FDF7FF | Page background (very light lavender) |
| `light-surface-container-lowest` | #FFFFFF | Cards, header, bottom nav, sidebar |
| `light-surface-container-low` | #F8F1FF | Fields, inner rows, secondary button |
| `light-surface-container` | #F2EAFF | Neutral chips (for example "Demo data") |
| `light-surface-container-high` | #EDE4FD | Rare |
| `light-surface-container-highest` | #E7DFF7 | Rare (progress tracks) |
| `light-surface-variant` | #FED9E2 | Pink tint: active Ops nav item, "INSIDE" chip, fare chip |
| `light-on-surface` | #1D192A | Primary text |
| `light-on-surface-variant` | #594047 | Secondary text (the most used text color) |
| `light-outline` | #8D6F77 | Placeholders, strong outlines |
| `light-outline-variant` | #E1BDC6 | Borders, used with opacity: /20, /30, /40 (most), /50, /60 |
| `light-inverse-surface` | #322E40 | Defined, not seen in use |

Defined but unused in the exports: every `dark-*` token, `light-surface-dim` #DED6EE, `light-inverse-*`.

Usage counts across all screens show the hierarchy: `on-surface-variant` and `on-surface` for text, `surface-container-lowest` for cards, `surface-container-low` for inner fields, `primary` only for primary actions, active states and brand marks.

## Typography

Families (loaded in the exports from Google Fonts):

| Role | Family | Weights loaded |
|---|---|---|
| `display`, `headline` | "Red Hat Text" | 600, 700 |
| `title`, `body`, `label` | "Instrument Sans" | 400, 500, 600, 700 |
| `mono` (fares, IDs, times, numbers, "Unavailable" values) | "Spline Sans Mono" | 500, 600 |

Type scale (size / line height / letter spacing / weight):

| Token | Size | Line | Tracking | Weight | Seen in |
|---|---|---|---|---|---|
| `display-lg` | 36px | 42px | -0.5px | 700 | Ops page titles |
| `display-lg-mobile` | 28px | 34px | -0.4px | 700 | Student and Driver screen titles |
| `headline-lg` | 24px | 30px | -0.25px | 700 | Ops section titles |
| `headline-md` | 20px | 26px | -0.15px | 700 | Section titles |
| `title-lg` | 18px | 24px | 0 | 600 | Card titles, wordmark |
| `title-md` | 16px | 22px | 0 | 600 | Row titles, select values |
| `body-lg` | 15px | 22px | 0 | 400 | (defined, same as body-md) |
| `body-md` | 15px | 22px | 0 | 400 | Body text |
| `label-lg` | 15px | 20px | 0.1px | 600 | Button labels |
| `label-md` | 14px | 20px | 0.1px | 600 | Ops nav, table text, labels |
| `label-sm` | 13px | 18px | 0.15px | 500 | Captions, chips, badges, nav labels (most used) |
| `mono-md` | 14px | 18px | 0 | 600 | Fare on booking |
| `mono-sm` | 13px | 18px | 0 | 500 | IDs, times, table values, "Unavailable" |

Rules seen in the exports:
- **Smallest text is 13px.** No 10, 11 or 12px text anywhere.
- Headings pair `font-headline` (Red Hat Text) with a `headline-*`, `title-lg` or `display-*` size. Body pairs `font-body`; labels `font-label`.
- Numbers and fares use `font-mono` and `tabular-nums`.
- `text-pretty` on descriptive paragraphs.
- Icon sizes are set with arbitrary text sizes: 20px (most), 22px (bottom nav), 18px, 24px, 28px, 32px, 36px and 40px (empty and state illustrations).

## Spacing

| Token | Value | Use |
|---|---|---|
| `gutter-xs` | 4px | Tight gaps (icon and label) |
| `gutter-sm` | 8px | Default gap (most used), chip padding |
| `gutter-md` | 12px | Card internal gaps, field padding, Ops table cell padding |
| `gutter-lg` | 16px | Card padding, main column gap |
| `gutter-xl` | 24px | Button horizontal padding, page bottom padding |
| `section` | 28px | Defined (section spacing) |
| `page-margin` | 16px | Horizontal page gutter (Student, Driver) |

Raw Tailwind steps also appear: 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4 (2, 4, 6, 8, 10, 12, 14, 16px). Ops tables use `py-3.5 pr-4` cells (14px / 16px), `py-3` and `py-2.5` headers.

## Radius

| Token | Value | Use |
|---|---|---|
| `rounded-sm` | 8px | "INSIDE"/"OPS" chip, small tags |
| `rounded` (DEFAULT) | 12px | Fields, inner rows, brand square, Ops nav items |
| `rounded-md` | 16px | Interactive list cards (`card-interactive`) |
| `rounded-lg` | 20px | Defined, rarely used |
| `rounded-xl` | 24px | Cards (`card-elevated`, `card-action`), Ops panels |
| `rounded-full` | 9999px | Buttons, icon buttons, chips, badges, avatars |

Note: Stitch **redefines** Tailwind's default radius names (its `rounded-xl` is 24px, Tailwind v4's is 12px). Compare in pixels.

## Borders, shadows, surfaces

- Cards: white (`surface-container-lowest`), `border` 1px `outline-variant/40`, shadow `0 4px 16px rgba(29,25,42,0.06)`.
- Action card: `border-2 primary/25` (or `/30`), same shadow.
- Small raised elements (brand square, icon buttons on maps, primary buttons): `shadow-sm`.
- Dividers: `border-t` or `border-b` `outline-variant/20` to `/40`. Header has `border-b outline-variant/40`; bottom nav `border-t outline-variant/40`.
- Fields: `surface-container-low` with `border outline-variant/50` to `/60`.
- No gradients.

## Components (from `data-component-id`)

| Component | Spec |
|---|---|
| `button-primary` | Full width, `rounded-full`, bg `primary`, text `on-primary`, `min-h` 48px (52px for the Driver action buttons on pickup-boarding, drop-off and trip-completed), padding 12px × 24px, gap 8px, `shadow-sm`, hover bg `primary-container`, transition `colors` 120ms ease-out. Label `label-lg` |
| `button-secondary` | Full width, `rounded-full`, bg `surface-container-low`, `border outline-variant`, text `primary`, `min-h` 48px, hover bg `surface-variant/40` |
| `button-with-icon` | Primary style with a leading icon; `min-h` 44 or 48px |
| `button-icon` | 44 × 44px, `rounded-full`, bg white, `border outline-variant/60`, text `on-surface`, hover `surface-container-low` |
| `card-elevated` | `rounded-xl` (24px), padding 16px, gap 8 or 12px, white, border `/40`, card shadow |
| `card-action` | As elevated with `border-2 primary/25` |
| `card-interactive` | Link card, `rounded-md` (16px), `min-h` 88px, padding 16px, hover `surface-container-low` |
| `badge-success` / `badge-warning` / `badge-error` | `rounded-full`, padding 4px × 8px, gap 4px, bg `*-container`, text `on-*-container`, `label-sm` |
| Neutral chip ("Demo data") | `rounded-full`, bg `surface-container`, text `on-surface-variant`, `label-sm`, padding 4px × 8px |
| Fare chip | `rounded-full`, bg `surface-variant` or `surface-container-low`, text `primary`, `font-mono` `mono-sm`/`mono-md`, `tabular-nums` |
| Text input | `min-h` 44px, `rounded-full`, bg `surface-container-low`, `border outline-variant/60`, padding 8px × 16px, `body-md`, placeholder `outline`, focus border `primary` |
| Select (in field) | Transparent, no border, `title-md`, inside a 56px-tall `rounded` field with a 32px round icon |
| Ops table | `w-full text-left border-collapse`; header row `label-sm` `on-surface-variant`, `border-b outline-variant/40`; rows `border-b outline-variant/20`; numeric cells `mono-sm` |

## Navigation and layout

| Area | Frame | Navigation |
|---|---|---|
| Student | `max-w-md` (448px) centered, page bg `surface`, designed at 884px tall | Sticky top header (white, `border-b`, brand + campus chip + 44px avatar); sticky **bottom nav, 5 tabs**: Home, Quick, My Rides, Campus Map, Profile. Tab: 44px min height, 22px icon over `label-sm` label; active = `primary` with filled icon and `aria-current="page"` |
| Driver | Same mobile frame | Sticky top header; sticky **bottom nav, 3 tabs**: Home, Active Trip, Cart (same tab style) |
| Ops | `max-w-[1440px]`, designed at 1024px tall, `flex-col` below `lg`, `flex-row` from `lg` (1024px) | **Sidebar** 256px (`lg:w-64`), white, `border-r`; brand "jeeny" + "OPS" chip + campus name; nav items 40px tall, `rounded` 12px, `label-md`, 20px icon; active = bg `surface-variant`, text `primary`, filled icon. Below `lg` the same nav is a horizontal scrolling row |

Breakpoints used: `lg` (81 uses, Ops), `sm` (6), `xl` (5), `md` (2). Student and Driver are single-column mobile layouts. Touch targets: `min-h-[44px]` or more for interactive rows and tabs.

## Motion

| Token | Duration | Easing |
|---|---|---|
| `state-change` (hover, color) | 120ms | ease-out |
| `surface-enter` | 240ms | cubic-bezier(0.2, 0, 0, 1) |
| `surface-exit` | 160ms | cubic-bezier(0.3, 0, 1, 1) |

Only `transition-colors` with `state-change` and `animate-spin` (loading) are used.

## Icons

Stitch uses **Material Symbols Outlined** (Google Fonts icon font), filled variant for the active nav item. Common: electric_rickshaw (brand), route, arrow_back, map, hail, group, analytics, dashboard, battery_charging_full, tune, home, location_on, chevron_right, nfc, info. Sizes 18 to 22px in UI, larger in state illustrations. See Unresolved U-2.

## Brand lockup in the exports

36px `rounded` (12px) square, bg `primary`, white electric_rickshaw icon, `shadow-sm`; then "jeeny" in `font-headline title-lg primary tracking-tight` and a chip ("INSIDE" in Student and Driver, "OPS" in Ops) in `label-sm`, bg `surface-variant`, text `primary`, `rounded-sm`. See Unresolved U-4.

## Integrity labels in the exports

- "Demo data" neutral chip (Student home and others).
- "Unavailable" for every value with no data source (46 plain uses plus variants such as "ETA: Unavailable", "Battery telemetry unavailable"), in `mono-sm` `on-surface-variant`. Ops state screen: "Unavailable fields are not replaced with zeros."
- "(Demo)" on loyalty copy.
- The fare (0.25 JOD) appears **without** a "Simulated" label in the exports. See U-6.

## States (state screens)

`app-states` (Student), `driver-states` (Driver) and `dashboard-states` (Ops) show loading (`progress_activity` with `animate-spin`), empty, offline (`wifi_off`, `cloud_off`), error and stale-data patterns. Use them as the reference for those states in each area.

## Accessibility seen in the exports

- `aria-label` on icon buttons and nav, `aria-current="page"` on the active tab, `aria-hidden` on icons, `sr-only` text (2).
- Focus: `focus-visible:outline-2 outline-offset-2 outline-primary` on 7 of 102 Student interactive elements, **0 of 34 in Driver and 0 of 115 in Ops**. See U-7.
- Contrast (computed): white on primary 8.29:1; primary on page 7.87:1; on-surface-variant on page 8.86:1; on-surface on page 16.27:1; placeholder `outline` #8D6F77 on white **4.49:1** (just under 4.5:1).

## Code vs Stitch (current code is tokens v0)

| Item | Code today | Stitch |
|---|---|---|
| Primary | #E4097E (`brand`) | #9C0051 (`light-primary`); hover #C8006A |
| Page background | #FFFFFF | #FDF7FF |
| Inner surface | #F4F5F7 (`surface`) | #F8F1FF (`surface-container-low`) |
| Primary text | #14151A (`ink`) | #1D192A |
| Secondary text | #6B7080 (`muted`) | #594047 |
| Border | #E6E7EB (`line`) | #E1BDC6 at 20 to 60% opacity |
| Teal | #0FA3A3 (`accent`) | #006A63 (`secondary`) |
| Purple | #7C3AED (`dropoff`) | #593F8D (`tertiary`) |
| Success / danger / warning | #16A34A / #DC2626 / #D97706 | #006A61 / #BF0715 / #904D00 with containers |
| Fonts | System stack | Red Hat Text, Instrument Sans, Spline Sans Mono |
| Smallest text | 10 and 11px badges | 13px |
| Card radius | 20px (`rounded-tile`) | 24px (cards), 16px (link cards), 12px (fields) |
| Card surface | `ring-1 line`, no shadow | border `/40` plus 0 4px 16px shadow |
| Primary button | 56px tall, `font-bold`, no focus style | 48px min height, `label-lg` 600, `shadow-sm`, hover state |
| Icons | Inline SVG, 3 icons | Material Symbols |
| Navigation | `AreaLayout` header with a back (switch persona) button; no tab bars or sidebar | Bottom nav (Student 5, Driver 3), Ops sidebar |
| Lockup | Original route-mark SVG + "Jeeny INSIDE" | electric_rickshaw square + "jeeny" + "INSIDE"/"OPS" chip |
| Integrity labels | "Sample data", "Simulated", "Simulated fare", "not verified" badges | "Demo data", "Unavailable", "(Demo)" |

## Unresolved (decisions needed; do not invent a value)

- **U-1 Fonts need an external font service.** The exports load Red Hat Text, Instrument Sans and Spline Sans Mono from Google Fonts. The project forbids external font services and new dependencies. Until the user decides (for example, self-hosted font files approved explicitly, or keep the system stack), report font differences as "Blocked by U-1" and never propose adding a font link or package.
- **U-2 Icons need an icon font.** Material Symbols is a Google Fonts icon library; icon libraries are forbidden. The code draws inline SVG. Until decided, audit icon **size, color, placement and meaning** against Stitch, not the glyph source; never propose adding Material Symbols.
- **U-3 The implemented Student App does not match the Student Stitch export** (colors, fonts, radius, shadows, navigation, lockup all differ). The user states both that the Student App is approved and must not be redesigned, and that the Student Stitch export is the approved reference. Until the user says which one governs the Student code, Student findings are reported for information only and no Student fix is proposed. (Update: the user has since made Stitch a secondary, historical reference, see `SKILL.md` section 2. That removes the Stitch export as an authority but does not approve any Student visual change, so U-3 stays open until the user decides.)
- **U-4 Brand lockup.** Stitch uses a lowercase "jeeny" wordmark with an electric_rickshaw icon; the code uses an original route mark with "Jeeny INSIDE" (Foundation Plan D5: no official Jeeny assets or implied affiliation). Which lockup is canonical is unresolved; never propose one that imitates the official Jeeny logo.
- **U-5 Navigation patterns.** Stitch bottom nav and Ops sidebar link to screens with no implementation (Quick, Campus Map, Profile, Battery Rescue, Campus Intelligence and others). Adding navigation to non-existent screens would fabricate functionality. Report as "Design without implementation"; never propose dead links. **Student clarification:** the user has approved the five-tab Student navigation **direction** (Home, Quick, My Rides, Campus Map, Profile). That approves the structure only; it does not mean each destination exists, and it is not permission to expand product scope. The audit reports each tab as one of: **approved direction** (the five-tab structure itself), **implemented** (a working screen exists in the code; verify, do not assume), or **planned, awaiting implementation** (approved in direction, no screen yet). A planned destination is never reported as a working feature, and the audit never proposes placeholder screens, dead links or stub functionality for it; building it is a separate decision for the user.
- **U-6 Fare label.** Stitch shows "0.25 JOD" without "Simulated". The Foundation Plan (D8) and the code require "Simulated fare" beside every price. The code's label wins until the user decides otherwise.
- **U-7 Focus style is inconsistent inside Stitch** (7 of 251 interactive elements). The audit treats a visible focus style as required everywhere (accessibility requirement). The Stitch style (`outline 2px, offset 2px, primary`) is a historical measurement from the archived exports, informational only: not an approved token and not a mandatory value. Any clearly visible focus indication that meets contrast requirements satisfies the audit.
- **U-8 Primary button height.** Historical measurements from the archived exports: 48px on most screens and 52px for the Driver action buttons (pickup-boarding, drop-off, trip-completed); the code uses 56px everywhere. These measurements are informational only, not approved tokens and not mandatory values; no button height is approved. The audit requires touch targets of at least 44 × 44px and consistent heights for the same role across areas; differences from the historical measurements are reported for information. The Student code's 56px is covered by U-3.
- **U-9 Label wording.** Stitch says "Demo data"; the code says "Sample data" and "Simulated". Wording changes are not proposed without a decision; both are acceptable integrity labels, but "Simulated" must never be removed.
- **U-10 Placeholder contrast** #8D6F77 on white is 4.49:1, just under WCAG AA 4.5:1. Report, do not silently change the token.
- **U-11 Data in the exports is illustrative** (persona "Alex", cart "C-04", trip "TRP-1082", external avatar images). It is never a reference for content, data, metrics or features.
