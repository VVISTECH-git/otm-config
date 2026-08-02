import { runQuery } from "../otm/dbxml";
import { q } from "../db";
import { cfg } from "../config";

/** Choose a stable per-row key: prefer *_GID, then *_XID, else hash the row. */
function pickPk(row: Record<string, string>): string {
  const keys = Object.keys(row);
  const gid = keys.find((k) => k.endsWith("_GID"));
  const xid = keys.find((k) => k.endsWith("_XID"));
  const col = gid ?? xid;
  return col ? row[col] : JSON.stringify(row);
}

/** OTM DBXML dates come back like "2024-01-15 12:30:00" (or similar). */
function parseOtmDate(v: string | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v.replace(" ", "T"));
  return isNaN(d.getTime()) ? null : d;
}
function toOra(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Delta-fetch every enabled table for a connection and upsert into the store.
 * WHERE domain_name=<domain> AND (first run ? all : update_date > watermark).
 * Advances the per-table watermark to the max update_date seen.
 *
 * TODO(next): object-level re-pull for child graphs; delete reconcile; the
 * OTM date format above should be re-confirmed against live output.
 */
export async function runFetch(connectionId: number) {
  const run = await q(
    `insert into fetch_run (connection_id) values ($1) returning id`,
    [connectionId],
  );
  const runId = run.rows[0].id as number;
  let tablesFetched = 0;
  let recordsUpserted = 0;

  try {
    const enabled = await q(
      `select table_name, last_watermark from otm_config_table
       where connection_id=$1 and enabled=true order by table_name`,
      [connectionId],
    );

    for (const t of enabled.rows) {
      const tbl = t.table_name as string;
      const wm = t.last_watermark ? new Date(t.last_watermark) : null;

      const where = [`domain_name='${cfg.otm.domain}'`];
      if (wm) {
        where.push(
          `update_date > TO_TIMESTAMP('${toOra(wm)}','YYYY-MM-DD HH24:MI:SS')`,
        );
      }
      const rows = await runQuery(
        `select * from ${tbl} where ${where.join(" and ")}`,
        "Row",
      );

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
    }

    await q(
      `update fetch_run set finished_at=now(), status='ok',
         tables_fetched=$2, records_upserted=$3 where id=$1`,
      [runId, tablesFetched, recordsUpserted],
    );
    return { runId, tablesFetched, recordsUpserted };
  } catch (e: any) {
    await q(
      `update fetch_run set finished_at=now(), status='error', error=$2 where id=$1`,
      [runId, String(e?.message ?? e)],
    );
    throw e;
  }
}
