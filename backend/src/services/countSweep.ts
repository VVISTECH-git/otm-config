import { runQuery } from "../otm/dbxml";
import { q } from "../db";
import { cfg } from "../config";
import { listDomainTables } from "./metadata";

const BATCH = 50;

/**
 * Sweep count(*) where domain_name=<domain> for every domain-scoped object and
 * upsert the counts into otm_config_table. Batched via UNION ALL, with a
 * per-table fallback if a batch fails. Long-running (minutes) — call in the
 * background and poll /api/tables.
 */
export async function sweepCounts(connectionId: number): Promise<{ tables: number }> {
  const tables = await listDomainTables();
  const dom = cfg.otm.domain;

  const countExpr = (t: string) =>
    `select '${t}' TBL, count(*) CNT from ${t} where domain_name='${dom}'`;

  for (let i = 0; i < tables.length; i += BATCH) {
    const chunk = tables.slice(i, i + BATCH);
    let rows: Record<string, string>[] = [];
    try {
      rows = await runQuery(chunk.map(countExpr).join(" union all "), "R");
      if (rows.length !== chunk.length) throw new Error("row/table mismatch");
    } catch {
      // fallback: count each table individually so one bad object can't sink the batch
      rows = [];
      for (const t of chunk) {
        try {
          rows.push(...(await runQuery(countExpr(t), "R")));
        } catch {
          rows.push({ TBL: t, CNT: "-1" });
        }
      }
    }
    for (const row of rows) {
      await q(
        `insert into otm_config_table (connection_id, table_name, tms_row_count, last_swept_at)
         values ($1,$2,$3, now())
         on conflict (connection_id, table_name)
         do update set tms_row_count = excluded.tms_row_count, last_swept_at = now()`,
        [connectionId, row.TBL, Number(row.CNT)],
      );
    }
  }
  return { tables: tables.length };
}
