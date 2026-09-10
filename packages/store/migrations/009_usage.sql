create table usage_events (
  id                uuid primary key default gen_random_uuid(),
  owner_id          uuid references users(id) on delete cascade,
  generation_id     uuid references generations(id) on delete set null,
  role              text not null,
  provider          text not null,
  model             text not null,
  prompt_tokens     integer not null,
  completion_tokens integer not null,
  cached_tokens     integer not null default 0,
  billable          boolean not null,
  created_at        timestamptz not null default now()
);

create index usage_events_owner_month_idx on usage_events (owner_id, created_at desc);
