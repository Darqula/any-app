alter table provider_credentials
  add column owner_id uuid references users(id) on delete cascade,
  alter column session_id drop not null;

alter table provider_credentials
  add constraint credential_subject_ck
    check ((owner_id is null) <> (session_id is null));

alter table provider_credentials drop constraint provider_credentials_session_id_provider_key;

create unique index credential_owner_provider_idx
  on provider_credentials (owner_id, provider) where owner_id is not null;
create unique index credential_session_provider_idx
  on provider_credentials (session_id, provider) where session_id is not null;
