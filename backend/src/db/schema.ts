// Schema as a SQL string so it ships in the compiled build without a file-copy step.
export const SCHEMA_SQL = `
create table if not exists otm_connection (
  id          serial primary key,
  name        text not null unique,
  base_url    text not null,
  domain      text not null default 'TMS',
  created_at  timestamptz not null default now()
);

-- The manifest: which OTM objects exist, their TMS row count, and whether
-- the user marked them as configuration (the checkbox).
create table if not exists otm_config_table (
  id               serial primary key,
  connection_id    int not null references otm_connection(id) on delete cascade,
  table_name       text not null,
  tms_row_count    bigint,
  enabled          boolean not null default false,
  pk_column        text,
  is_view          boolean not null default false,
  has_update_date  boolean not null default true,
  last_watermark   timestamptz,
  last_swept_at    timestamptz,
  last_fetched_at  timestamptz,
  unique (connection_id, table_name)
);

-- The flexible store: one row per OTM record, full row kept as JSONB.
create table if not exists otm_config_record (
  connection_id  int not null references otm_connection(id) on delete cascade,
  table_name     text not null,
  pk_value       text not null,
  payload        jsonb not null,
  domain_name    text,
  update_date    timestamptz,
  fetched_at     timestamptz not null default now(),
  deleted        boolean not null default false,
  primary key (connection_id, table_name, pk_value)
);
create index if not exists idx_record_table
  on otm_config_record (connection_id, table_name);

-- Audit log, one row per Run.
create table if not exists fetch_run (
  id                serial primary key,
  connection_id     int not null references otm_connection(id) on delete cascade,
  started_at        timestamptz not null default now(),
  finished_at       timestamptz,
  status            text not null default 'running',
  tables_fetched    int not null default 0,
  records_upserted  int not null default 0,
  error             text
);

-- idempotent column adds (apply to already-created tables on redeploy)
alter table otm_config_table add column if not exists category text;
alter table otm_config_table add column if not exists column_order jsonb;
`;
