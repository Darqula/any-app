create table records (
  id          uuid primary key default gen_random_uuid(),
  app_id      uuid not null,
  collection  text not null,
  data        jsonb not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Serves both the listing order and the quota's count(*), which filters on app_id alone.
create index records_app_collection_idx
  on records (app_id, collection, created_at desc, id desc);

-- jsonb_path_ops: smaller and faster, and it serves exactly the @> containment the data API's
-- equality-only filters compile to.
create index records_data_idx on records using gin (data jsonb_path_ops);

-- The sandbox's restricted role is not created here (it needs a password). Run once by hand:
--
--   create role anyapp_sandbox login password 'choose-one';
--   grant usage on schema public to anyapp_sandbox;
--   grant select, insert, update, delete on records to anyapp_sandbox;
--
-- That is the whole grant: a new role has no rights on existing tables. Verify that
-- `generations` and `provider_credentials` stay unreachable; a stray
-- `grant ... on all tables` would undo the sandbox's isolation.
