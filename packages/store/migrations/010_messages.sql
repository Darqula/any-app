-- Per-app conversation log for the studio's bottom panel. `seq` (not created_at) orders messages and is
-- the polling cursor. The first user message is generations.prompt, not a row.
create table messages (
  id             uuid primary key default gen_random_uuid(),
  seq            bigserial not null,
  generation_id  uuid not null references generations(id) on delete cascade,
  role           text not null check (role in ('user', 'assistant')),
  kind           text not null check (kind in ('create', 'edit', 'error', 'note')),
  -- Region id, "css" or "shell" when known.
  target         text,
  body           text not null,
  created_at     timestamptz not null default now()
);

create unique index messages_seq_idx on messages (seq);
create index messages_generation_idx on messages (generation_id, seq);
