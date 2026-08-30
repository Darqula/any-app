create extension if not exists "pgcrypto";

create table generations (
  id          uuid primary key default gen_random_uuid(),
  prompt      text not null,
  status      text not null default 'pending',
  document    text,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index generations_created_at_idx on generations (created_at desc);
