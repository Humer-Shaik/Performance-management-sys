# Performance Management System

Version one of the plan of Nov 4, 2026: scores are calculated from locked rules
and recorded evidence, nothing is overwritten, and every change is logged in a
hash-chained audit trail.

## What is here so far (milestone 1: foundation)

| Path | What it does |
| --- | --- |
| `db/migrations/001_schema.sql` | Tables for people, teams, goals, subtasks, revisions, blockers, ratings, disputes, rule versions, periods, score snapshots. Originals live on the entity; every change is a revision row. |
| `db/migrations/002_audit_and_immutability.sql` | Append-only audit log with a SHA-256 hash chain, triggers that refuse UPDATE/DELETE/TRUNCATE on history tables (only "set once" columns can be filled in), and `verify_audit_chain()`. |
| `db/migrations/003_roles.sql` | `pms_app` (no score writes, no direct log writes), `pms_scoring` (only writer of scores), `pms_readonly`. |
| `db/migrations/004_views.sql` | Current values derived from originals plus revisions. |
| `src/scoring/` | The scoring engine: a pure function of inputs and one rule version, with a full per-task breakdown and "insufficient data" handling. |
| `src/domain/progress.ts` | Effort-weighted progress and deadline risk levels. |

## Server commands (`src/server`)

Each command loads the actor, checks the plan's rules, and writes in one transaction with the actor and reason set for the audit log.

| File | Commands |
| --- | --- |
| `goals.ts` | `createGoal`, `transferGoal` (freezes progress and overdue status, notifies the owner), `requestTeamExtension` |
| `subtasks.ts` | `createSubtask` (team deadline, minimum lead time, reference effort, warnings), `changeEstimate`, `extendDeadline`, `requestMoreTime`, `reassign` (credit stays with the first employee), `splitSubtask`, `mergeSubtasks`, `setStatus` (review flow, reopen counts against the deliverer), `updateProgress` |
| `requests.ts` | `decideChangeRequest` (never by the requester), `escalateRefusedRequest` |
| `blockers.ts` | `raiseBlocker`, `acknowledgeBlocker`, `disputeBlocker`, `decideBlocker` (manager only), `resolveBlocker`, `escalateLongBlockers` (scheduled job) |
| `policy.ts` | Who can do what, per role and team |
| `ratings.ts` | `rateQuality` (evidence rules for 1, 2, 4, 5), `changeQualityRating` (new version with reason, employee told), `reviewQualityRating` (manager), `rateCollaboration` (lead or teammates, examples required, raters never shown) |
| `disputes.ts` | `fileDispute` (affected employee only, 14-day window, challenged person and reviewer found from the record), `decideDispute` (never the challenged person; applies the correction as a new revision), `rescoreAfterDisputes` (revised locked score, old one kept), `escalateOverdueDisputes` (to head of HR after 10 working days) |
| `scoring.ts` | `openPeriod` (HR), `computeDrafts` (nightly), `lockPeriod` (quarter end), `scoreBreakdown` (who may see it). Runs as `pms_scoring`, the only role that can write scores. |

## Running

```sh
npm install
npm run test:unit                                   # scoring and risk rules
TEST_ADMIN_URL=postgres://postgres:pw@localhost/postgres npm run test:db   # database safeguards (PostgreSQL 16)
DATABASE_URL=postgres://owner:pw@host/db npm run db:migrate
```

Every write must say who is acting and why, inside the transaction:

```sql
SELECT set_config('app.actor_id', '<user uuid>', true), set_config('app.reason', '<why>', true);
```

## Next milestones

2. Work: goals, transfers, subtasks, revisions with approvals, status events, blockers (commands done; screens come with milestone 5).
3. Ratings and scoring: rubric forms, collaboration form, nightly score job, breakdown page, quarter lock.
4. Disputes and approvals (done; screens come with milestone 5).
5. Dashboards per role, risk job and notifications, accountability reports, export.
