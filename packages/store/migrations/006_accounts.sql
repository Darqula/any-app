create table users (
  id                   uuid primary key default gen_random_uuid(),
  email                text not null unique,
  password_hash        text not null,
  monthly_token_limit  integer,
  created_at           timestamptz not null default now()
);

create table sessions (
  id           text primary key,
  user_id      uuid references users(id) on delete cascade,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index sessions_user_idx on sessions (user_id);
