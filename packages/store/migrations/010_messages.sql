-- The conversation log shown in the studio's expandable bottom panel: what the user asked and
-- what the studio (or, later, the model) said back, per app.
--
-- `seq`, not `created_at`, is the ordering and the polling cursor: two messages written in the
-- same statement/millisecond tie on a timestamp, and a client asking "everything after the last
-- one I have" needs a strictly increasing key. `on delete cascade` so removing an app removes
-- its conversation with it (see store's deleteGeneration); a remix does NOT copy this table.
--
-- The very first user message of an app is not stored here — it is `generations.prompt`, which
-- the studio renders as message zero. That is what keeps every app created before this
-- migration showing a sensible conversation without a backfill.
create table messages (
  id             uuid primary key default gen_random_uuid(),
  seq            bigserial not null,
  generation_id  uuid not null references generations(id) on delete cascade,
  role           text not null check (role in ('user', 'assistant')),
  -- create: about the initial generation; edit: about a follow-up; error: a failure worth
  -- reading; note: anything else the studio wants to say.
  kind           text not null check (kind in ('create', 'edit', 'error', 'note')),
  -- The region id or "css" an edit targeted, when known.
  target         text,
  body           text not null,
  created_at     timestamptz not null default now()
);

create unique index messages_seq_idx on messages (seq);
create index messages_generation_idx on messages (generation_id, seq);
