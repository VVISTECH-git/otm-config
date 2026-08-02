import { runQuery } from "../otm/dbxml";
import { q } from "../db";
import { cfg } from "../config";

const FETCH_TIMEOUT = 120000; // per-table fetch cap

/** Choose a stable per-row key: prefer *_GID, then *_XID, else hash the row. */
function pickPk(row: Record<string, string>): string {
  const keys = Object.keys(row);
  const gid = keys.find((k) => k.endsWith("_GID"));
  const xid = keys.find((k) => k.endsWith("_XID"));
  const col = gid ?? xid;
  return col ? row[col] : JSON.stringify(row);
}

/** OTM DBXML dates come back like "2024-01-15 12:30:00". */
function parseOtmDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
function toOra(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Delta-fetch every enabled table for a connection into otm_config_record,
 * updating the given fetch_run row as it goes. Per-table resilient: one table
 * failing (timeout / SQL error) is recorded and the run continues.
 *
 * WHERE domain_name=<domain> AND (first run ? all : update_date > watermark).
 * TODO(next): object-level re-pull for child graphs; delete reconcile.
 */
export async function runFetch(connectionId: number, runId: number) {
  let tablesFetched = 0;
  let recordsUpserted = 0;
  const errs: string[] = [];

  const enabled = await q(
    `select table_name, last_watermark from otm_config_table
     where connection_id=$1 and enabled=true order by table_name`,
    [connectionId],
  );

  for (const t of enabled.rows) {
    const tbl = t.table_name as string;
    const wm = t.last_watermark ? new Date(t.last_watermark) : null;
    try {
      const where = [`domain_name='${cfg.otm.domain}'`];
      if (wm) where.push(`update_date > TO_TIMESTAMP('${toOra(wm)}','YYYY-MM-DD HH24:MI:SS')`);
      const rows = await runQuery(`select * from ${tbl} where ${where.join(" and ")}`, "Row", FETCH_TIMEOUT);

      let maxUpd = wm;
      for (const row of rows) {
        const pk = pickPk(row);
        const upd = parseOtmDate(row.UPDATE_DATE);
        if (upd && (!maxUpd || upd > maxUpd)) maxUpd = upd;
        await q(
          `insert into otm_config_record
             (connection_id, table_name, pk_value, payload, domain_name, update_date, fetched_at, deleted)
           values ($1,$2,$3,$4,$5,$6, now(), false)
           on conflict (connection_id, table_name, pk_value)
           do update set payload=excluded.payload, domain_name=excluded.domain_name,
                         update_date=excluded.update_date, fetched_at=now(), deleted=false`,
          [connectionId, tbl, pk, JSON.stringify(row), row.DOMAIN_NAME ?? null, upd],
        );
        recordsUpserted++;
      }

      await q(
        `update otm_config_table set last_watermark=$2, last_fetched_at=now()
         where connection_id=$1 and table_name=$3`,
        [connectionId, maxUpd, tbl],
      );
      tablesFetched++;
    } catch (e: any) {
      errs.push(`${tbl}: ${String(e?.message ?? e).slice(0, 120)}`);
    }

    // progress so the UI can poll
    await q(
      `update fetch_run set tables_fetched=$2, records_upserted=$3 where id=$1`,
      [runId, tablesFetched, recordsUpserted],
    );
  }

  const status = errs.length === 0 ? "ok" : tablesFetched > 0 ? "partial" : "error";
  await q(
    `update fetch_run set finished_at=now(), status=$2, tables_fetched=$3, records_upserted=$4, error=$5 where id=$1`,
    [runId, status, tablesFetched, recordsUpserted, errs.length ? errs.join(" | ").slice(0, 1000) : null],
  );
  return { runId, tablesFetched, recordsUpserted, errors: errs.length };
}
