alter table generations
  add column owner_id    uuid references users(id) on delete cascade,
  add column session_id  text,
  add column visibility  text not null default 'private',
  add column forked_from uuid references generations(id) on delete set null;

alter table generations
  add constraint generations_visibility_ck
    check (visibility in ('private', 'unlisted', 'public'));

create index generations_owner_idx on generations (owner_id, created_at desc);
create index generations_session_idx on generations (session_id, created_at desc)
  where owner_id is null;
