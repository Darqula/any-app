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

-- jsonb_path_ops, not the default jsonb_ops: smaller, faster, and it supports exactly the
-- containment operator (@>) that the data API's equality-only filters compile to. Choosing
-- the narrower operator class is the same decision as choosing the narrower API — see
-- .docs/impl-phase-5.md step 5.
create index records_data_idx on records using gin (data jsonb_path_ops);

-- The restricted role the sandbox connects as (packages/records) is NOT created here — it
-- needs a password, and migrations are committed. Run once by hand, the same way the
-- `anyapp` database itself was created (see .docs/impl-phase-0-1.md step 0.3):
--
--   create role anyapp_sandbox login password 'choose-one';
--   grant usage on schema public to anyapp_sandbox;
--   grant select, insert, update, delete on records to anyapp_sandbox;
--
-- That is the whole grant. A freshly created role has no privileges on pre-existing tables,
-- so `generations` and `provider_credentials` are already unreachable to it — but verify
-- this rather than assume it (see .docs/impl-phase-5.md step 3's verification queries),
-- because it is the load-bearing half of this phase's security story and a stray
-- `grant ... on all tables in schema public` in someone's setup notes would quietly undo it.
