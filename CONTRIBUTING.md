# Contributing to Jeeny INSIDE

Thanks for helping. This guide covers the branch model, pull requests, commit messages, the checks every change must pass, the business rules that must not change without agreement, and what must never be committed.

## Setup

- Node.js **22.13 or newer** (22.x), or 23.4+. The server uses Node's built-in SQLite module.
- `npm install`, then `npm run dev` (development, http://localhost:5173) or `npm start` (production build, http://localhost:3000).
- The three-phone demo is at `/demo`. Technical details are in [docs/TECHNICAL.md](docs/TECHNICAL.md).

## Branches

| Branch | Purpose | Updated by |
|---|---|---|
| `main` | Stable presentation and release branch (default) | Pull request from `develop` only |
| `develop` | Integration and testing | Pull requests from short-lived branches |
| `feature/<short-name>` | New functionality | You, branched from `develop` |
| `fix/<short-name>` | Bug fixes | You, branched from `develop` |
| `docs/<short-name>` | Documentation only | You, branched from `develop` |

- Use lowercase and hyphens: `feature/ride-history-filter`, `fix/eta-rounding`, `docs/replit-steps`.
- Keep branches short-lived and focused on one change. Update from `develop` before opening a pull request.
- Never push directly to `main` or `develop`, never force-push them, and never delete them.
- `claude/project-thread-dtlobs` holds the original integrated history and stays as it is. Do not open pull requests from it: merged branches are deleted automatically.

## Pull requests

1. Open the pull request into `develop` and fill in the template.
2. CI must pass (see "Required checks").
3. Get a review from another team member when possible.
4. Merge feature, fix and docs pull requests with **Squash and merge**. Their branches are then deleted automatically.
5. To release or update the presentation build, open a pull request from `develop` into `main` and merge it with **Create a merge commit**. Rebase merging is disabled.

## Commit messages

Use the style already in the history: a type, an optional scope and a short summary in the imperative.

```
feat(student): add ride history filter
fix(driver): keep the arrival button visible on small screens
docs: explain the Replit storage limits
test(engine): cover the loyalty reset after a free ride
chore(ci): cache npm dependencies
```

Types: `feat`, `fix`, `docs`, `test`, `refactor`, `style`, `chore`. Explain the "why" in the body when it is not obvious.

## Required checks

Before opening a pull request, run:

```bash
npm run check   # typecheck, all tests, production build
```

CI runs the same command (`npm ci` and `npm run check` on Node.js 22) on every pull request and push to `develop` and `main`. Do not delete or weaken tests to make a change pass. For UI changes, check light and dark themes, a phone width and a desktop width, and add screenshots to the pull request.

## Protected business rules

These are approved product rules. Do not change them without the team's explicit agreement, recorded in the pull request.

- Simulated fare of **0.25 JOD** per ride; shared rides cost the same per rider. No real payment.
- Loyalty: after **5 completed paid rides**, the next ride is free. Cancelled and free rides do not count.
- Ghost Ride (shared rides): riders join only through dispatch, only before anyone has boarded, within the approved maximum added delay (**4 minutes**) and the seat and battery limits.
- Battery reserve of **15%**: carts below it get no new trips.
- NFC Tap-In is a **check-in only**. It never boards a passenger, never marks arrival for the driver and never changes ride, trip or cart status.
- The driver's steps are explicit: start, arrival at each stop, boarding and drop-off are separate driver actions. Nothing boards or drops off a passenger automatically.
- Dispatch is deterministic and explainable, and stays an explicit Operations action.
- REST is the only way to change state; Socket.IO only publishes. Clients never write REST answers into the live state.
- Existing API contracts and the database schema change only with a migration and agreement.

## Honesty rules

- Keep simulated data labelled as simulated: the fleet, cart positions (not GPS), battery and fares.
- Do not present rule-based logic as AI, estimates as measurements, or unimplemented features as working.
- Do not add fabricated metrics, users, ratings or live data.

## Never commit

- Databases: `data/`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `*.sqlite-journal`
- Generated files: `dist/`, `node_modules/`, logs
- Secrets: `.env` files, API keys, tokens, passwords
- Local tooling: `.claude/skills/ui-ux-pro-max/` and other personal skills or editor settings

Most of these are already in `.gitignore`. Check `git status` before every commit.

## Repository protection

The repository is private on a free GitHub plan, where branch protection and rulesets are not available. Until they are, the rules above (pull requests only, CI must pass, no direct or forced pushes to `main` and `develop`) are the protection. When protection becomes available, `main` should require a pull request and the `check` CI job, and block force pushes and deletion, with an admin bypass so the team is never locked out.
