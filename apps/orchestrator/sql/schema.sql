-- MolBhav v3 schema. Run once in the Supabase SQL editor.
-- Nothing here is skill-specific: facts are jsonb validated against the skill's
-- fact_schema in the engine, so a new market needs no migration.

create table if not exists missions (
  id                uuid primary key,
  skill_id          text not null,
  user_id           text not null,
  spec              jsonb not null default '{}'::jsonb,
  status            text not null default 'running',
  savings           numeric,
  best_value        numeric,
  best_counterparty text,
  created_at        timestamptz not null default now()
);

-- Rehearsals against a redirected number. Excluded from every public number.
alter table missions add column if not exists test boolean not null default false;

create index if not exists missions_skill_idx on missions (skill_id, created_at desc);

create table if not exists calls (
  id                 uuid primary key,
  mission_id         uuid not null references missions (id) on delete cascade,
  counterparty_name  text,
  counterparty_phone text,
  counterparty_kind  text,
  area               text,
  city               text,
  source             text,
  lang               text,
  state              text,
  outcome            text,
  rounds             int  not null default 0,
  first_quote        numeric,
  final_quote        numeric,
  facts              jsonb not null default '{}'::jsonb,
  transcript         jsonb not null default '[]'::jsonb,
  recording_url      text,
  started_at         timestamptz,
  ended_at           timestamptz
);

create index if not exists calls_mission_idx on calls (mission_id);
create index if not exists calls_outcome_idx on calls (outcome);

-- Numbers that asked us never to call again. Checked before every dial.
create table if not exists optouts (
  phone      text primary key,
  reason     text,
  created_at timestamptz not null default now()
);

-- Cross-category counters for the public page.
create or replace view public_stats as
select
  count(distinct m.user_id)                                as users,
  count(distinct m.id)                                     as missions,
  count(c.id)                                              as calls,
  coalesce(sum(m.savings), 0)                              as saved,
  count(c.id) filter (where c.outcome = 'dead_lead')       as dead_leads
from missions m
left join calls c on c.mission_id = m.id
where m.test is not true;

-- The Bhav Index: what a thing actually closes at, per market and locality.
create or replace view bhav_index as
select
  m.skill_id,
  coalesce(
    m.spec ->> 'item',
    m.spec ->> 'gig',
    m.spec ->> 'item_spec',
    c.area,
    'all'
  )                                                                        as grouping,
  count(*)                                                                 as samples,
  percentile_cont(0.5) within group (order by c.final_quote)                as median_close,
  min(c.final_quote)                                                       as low,
  max(c.final_quote)                                                       as high,
  max(c.ended_at)                                                          as last_seen
from calls c
join missions m on m.id = c.mission_id
where c.final_quote is not null
  and m.test is not true
group by 1, 2;
