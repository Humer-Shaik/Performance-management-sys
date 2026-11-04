-- Core schema. Every value a lead can change keeps an immutable original on the
-- entity plus one revision row per change. History tables are append-only
-- (see 002_immutability.sql).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE app_role AS ENUM ('employee', 'team_lead', 'manager', 'hr', 'head_of_hr', 'admin', 'owner');
CREATE TYPE subtask_status AS ENUM ('not_started', 'in_progress', 'blocked', 'in_review', 'done');
CREATE TYPE blocker_type AS ENUM ('internal', 'external', 'employee_caused');
CREATE TYPE blocker_event_kind AS ENUM ('acknowledged', 'disputed', 'upheld', 'rejected', 'resolved');
CREATE TYPE goal_priority AS ENUM ('low', 'normal', 'high');
CREATE TYPE request_status AS ENUM ('pending', 'approved', 'refused', 'escalated', 'applied');
CREATE TYPE dispute_outcome AS ENUM ('upheld', 'partly_upheld', 'rejected');
CREATE TYPE snapshot_status AS ENUM ('draft', 'locked', 'revised_by_dispute');

-- People and teams ---------------------------------------------------------

CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email        text NOT NULL UNIQUE,
  name         text NOT NULL,
  job_family   text NOT NULL DEFAULT 'general',
  manager_id   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE user_roles (
  id          bigserial PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        app_role NOT NULL,
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz,                -- set once to end the role
  granted_by  uuid REFERENCES users(id),
  reason      text NOT NULL
);

CREATE TABLE teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  lead_id     uuid NOT NULL REFERENCES users(id),
  manager_id  uuid NOT NULL REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE team_members (
  id          bigserial PRIMARY KEY,
  team_id     uuid NOT NULL REFERENCES teams(id),
  user_id     uuid NOT NULL REFERENCES users(id),
  valid_from  timestamptz NOT NULL DEFAULT now(),
  valid_to    timestamptz                 -- set once when the person leaves
);

-- Scoring rules and periods -------------------------------------------------

CREATE TABLE scoring_rule_versions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rules                  jsonb NOT NULL,  -- weights, thresholds, effort scale, lead times
  proposed_by            uuid NOT NULL REFERENCES users(id),
  proposed_at            timestamptz NOT NULL DEFAULT now(),
  reason                 text NOT NULL,
  approved_by            uuid REFERENCES users(id),   -- set once, by the owner
  approved_at            timestamptz,
  effective_from_period  text                         -- e.g. '2027-Q1', set with approval
);

CREATE TABLE periods (
  id         text PRIMARY KEY,           -- '2026-Q4'
  starts_on  date NOT NULL,
  ends_on    date NOT NULL,
  locked_at  timestamptz                 -- set once at quarter end
);

-- Goals ---------------------------------------------------------------------

CREATE TABLE goals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  description        text NOT NULL DEFAULT '',
  priority           goal_priority NOT NULL DEFAULT 'normal',
  created_by         uuid NOT NULL REFERENCES users(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  original_team_id   uuid NOT NULL REFERENCES teams(id),
  original_deadline  date NOT NULL
);

-- One row per period a team holds the goal. Transfers close the old row and
-- open a new one, freezing progress and overdue status at that moment.
CREATE TABLE goal_assignments (
  id                    bigserial PRIMARY KEY,
  goal_id               uuid NOT NULL REFERENCES goals(id),
  team_id               uuid NOT NULL REFERENCES teams(id),
  deadline              date NOT NULL,
  assigned_by           uuid NOT NULL REFERENCES users(id),
  assigned_at           timestamptz NOT NULL DEFAULT now(),
  reason                text NOT NULL,
  ended_at              timestamptz,    -- set once on transfer
  progress_at_transfer  numeric(5,2),   -- set once on transfer
  overdue_at_transfer   boolean         -- set once on transfer
);

-- Team deadline extensions, employee time requests, estimate changes after start,
-- reassignments after start: all go through this table.
CREATE TABLE change_requests (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target_type   text NOT NULL CHECK (target_type IN ('goal', 'subtask')),
  target_id     uuid NOT NULL,
  field         text NOT NULL CHECK (field IN ('deadline', 'points', 'assignee', 'scope', 'team')),
  old_value     jsonb NOT NULL,
  new_value     jsonb NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  requested_by  uuid NOT NULL REFERENCES users(id),
  requested_at  timestamptz NOT NULL DEFAULT now(),
  approver_id   uuid REFERENCES users(id)
);

CREATE TABLE change_request_decisions (
  id          bigserial PRIMARY KEY,
  request_id  uuid NOT NULL REFERENCES change_requests(id),
  status      request_status NOT NULL,
  decided_by  uuid NOT NULL REFERENCES users(id),
  decided_at  timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL
);

-- Subtasks ------------------------------------------------------------------

CREATE TABLE subtasks (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  goal_id              uuid NOT NULL REFERENCES goals(id),
  title                text NOT NULL,
  acceptance_criteria  text NOT NULL,
  review_required      boolean NOT NULL DEFAULT true,
  original_points      smallint NOT NULL CHECK (original_points IN (1, 2, 3, 5, 8)),
  reference_points     smallint NOT NULL CHECK (reference_points IN (1, 2, 3, 5, 8)),
  override_reason      text,
  original_due         date NOT NULL,
  original_assignee    uuid NOT NULL REFERENCES users(id),
  assigned_at          timestamptz NOT NULL DEFAULT now(),
  short_lead_reason    text,            -- required when due is below the minimum lead time
  created_by           uuid NOT NULL REFERENCES users(id),
  split_from           uuid REFERENCES subtasks(id),
  CHECK (original_points = reference_points OR override_reason IS NOT NULL)
);

-- Every change to points, due date, assignee or scope. The current value is the
-- latest applied revision; the original stays on the subtask row.
CREATE TABLE subtask_revisions (
  id            bigserial PRIMARY KEY,
  subtask_id    uuid NOT NULL REFERENCES subtasks(id),
  field         text NOT NULL CHECK (field IN ('points', 'due', 'assignee', 'scope')),
  old_value     jsonb NOT NULL,
  new_value     jsonb NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  changed_by    uuid NOT NULL REFERENCES users(id),
  changed_at    timestamptz NOT NULL DEFAULT now(),
  request_id    uuid REFERENCES change_requests(id)  -- set when an approval was needed
);

CREATE TABLE subtask_merges (
  id           bigserial PRIMARY KEY,
  merged_into  uuid NOT NULL REFERENCES subtasks(id),
  merged_from  uuid NOT NULL REFERENCES subtasks(id),
  merged_by    uuid NOT NULL REFERENCES users(id),
  merged_at    timestamptz NOT NULL DEFAULT now(),
  reason       text NOT NULL
);

CREATE TABLE status_events (
  id           bigserial PRIMARY KEY,
  subtask_id   uuid NOT NULL REFERENCES subtasks(id),
  from_status  subtask_status,
  to_status    subtask_status NOT NULL,
  actor_id     uuid NOT NULL REFERENCES users(id),
  at           timestamptz NOT NULL DEFAULT now(),
  note         text
);

CREATE TABLE progress_updates (
  id          bigserial PRIMARY KEY,
  subtask_id  uuid NOT NULL REFERENCES subtasks(id),
  author_id   uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  body        text NOT NULL
);

-- Blockers: raised by the employee, never deleted. Outcomes are events.
CREATE TABLE blockers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subtask_id  uuid NOT NULL REFERENCES subtasks(id),
  raised_by   uuid NOT NULL REFERENCES users(id),
  type        blocker_type NOT NULL,
  reason      text NOT NULL CHECK (length(trim(reason)) > 0),
  raised_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE blocker_events (
  id          bigserial PRIMARY KEY,
  blocker_id  uuid NOT NULL REFERENCES blockers(id),
  kind        blocker_event_kind NOT NULL,
  actor_id    uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  reason      text
);

-- Ratings -------------------------------------------------------------------

CREATE TABLE quality_ratings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subtask_id       uuid NOT NULL REFERENCES subtasks(id),
  employee_id      uuid NOT NULL REFERENCES users(id),
  rater_id         uuid NOT NULL REFERENCES users(id),
  score            smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  rubric_answers   jsonb NOT NULL DEFAULT '{}',
  reason           text,
  example          text,
  evidence_urls    text[] NOT NULL DEFAULT '{}',
  supersedes_id    uuid REFERENCES quality_ratings(id),
  change_reason    text,
  is_reopen        boolean NOT NULL DEFAULT false,  -- system rating of 1 written on reopen
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (rater_id <> employee_id),
  -- Evidence rules from the plan
  CHECK (score <> 1 OR is_reopen OR (coalesce(length(trim(reason)), 0) > 0 AND cardinality(evidence_urls) > 0)),
  CHECK (score <> 2 OR coalesce(length(trim(reason)), 0) > 0),
  CHECK (score <> 4 OR coalesce(length(trim(example)), 0) > 0),
  CHECK (score <> 5 OR cardinality(evidence_urls) > 0),
  CHECK (supersedes_id IS NULL OR coalesce(length(trim(change_reason)), 0) > 0)
);

CREATE TABLE quality_rating_reviews (
  id          bigserial PRIMARY KEY,
  rating_id   uuid NOT NULL REFERENCES quality_ratings(id),
  manager_id  uuid NOT NULL REFERENCES users(id),
  outcome     text NOT NULL CHECK (outcome IN ('confirmed', 'questioned', 'validated')),
  note        text,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE collaboration_ratings (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id   text NOT NULL REFERENCES periods(id),
  subject_id  uuid NOT NULL REFERENCES users(id),
  rater_id    uuid NOT NULL REFERENCES users(id),
  rater_kind  text NOT NULL CHECK (rater_kind IN ('lead', 'peer')),
  score       smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
  examples    text NOT NULL CHECK (length(trim(examples)) > 0),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CHECK (rater_id <> subject_id),
  UNIQUE (period_id, subject_id, rater_id)
);

-- Disputes ------------------------------------------------------------------

CREATE TABLE disputes (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  filed_by       uuid NOT NULL REFERENCES users(id),
  target_type    text NOT NULL CHECK (target_type IN
                   ('estimate', 'deadline', 'quality_rating', 'blocker_decision', 'review_comment', 'score')),
  target_id      text NOT NULL,
  challenged_user_id uuid NOT NULL REFERENCES users(id),
  evidence       text NOT NULL CHECK (length(trim(evidence)) > 0),
  filed_at       timestamptz NOT NULL DEFAULT now(),
  decision_made_at timestamptz NOT NULL,       -- when the challenged decision was made or published
  reviewer_id    uuid NOT NULL REFERENCES users(id),
  due_at         timestamptz NOT NULL,
  CHECK (reviewer_id <> challenged_user_id),
  CHECK (reviewer_id <> filed_by)
);

CREATE TABLE dispute_decisions (
  id            bigserial PRIMARY KEY,
  dispute_id    uuid NOT NULL UNIQUE REFERENCES disputes(id),
  outcome       dispute_outcome NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  decided_by    uuid NOT NULL REFERENCES users(id),
  decided_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE dispute_escalations (
  id          bigserial PRIMARY KEY,
  dispute_id  uuid NOT NULL REFERENCES disputes(id),
  escalated_to uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL
);

-- Scores --------------------------------------------------------------------

-- Written only by the scoring engine. A dispute that changes a locked score
-- writes a new snapshot that supersedes the old one.
CREATE TABLE score_snapshots (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id        text NOT NULL REFERENCES periods(id),
  employee_id      uuid NOT NULL REFERENCES users(id),
  rule_version_id  uuid NOT NULL REFERENCES scoring_rule_versions(id),
  inputs_hash      text NOT NULL,
  breakdown        jsonb NOT NULL,
  total            numeric(5,2),          -- null when every signal is insufficient
  status           snapshot_status NOT NULL,
  supersedes_id    uuid REFERENCES score_snapshots(id),
  dispute_id       uuid REFERENCES disputes(id),
  computed_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (status <> 'revised_by_dispute' OR (supersedes_id IS NOT NULL AND dispute_id IS NOT NULL))
);

-- Owner comments and review requests (the owner's only write).
CREATE TABLE owner_notes (
  id           bigserial PRIMARY KEY,
  author_id    uuid NOT NULL REFERENCES users(id),
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('comment', 'review_request')),
  body         text NOT NULL,
  at           timestamptz NOT NULL DEFAULT now()
);
