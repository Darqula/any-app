create table provider_credentials (
  id            uuid primary key default gen_random_uuid(),
  session_id    text not null,
  provider      text not null,
  base_url      text,
  ciphertext    bytea not null,
  iv            bytea not null,
  tag           bytea not null,
  hint          text not null,
  created_at    timestamptz not null default now(),
  validated_at  timestamptz,
  unique (session_id, provider)
);
