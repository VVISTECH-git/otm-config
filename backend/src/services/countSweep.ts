import { runQuery } from "../otm/dbxml";
import { q } from "../db";
import { cfg } from "../config";
import { listDomainTables } from "./metadata";
import { classifyCategory } from "./classify";

const BATCH = 40;
const BATCH_TIMEOUT = 60000; // 60s per batch
const SINGLE_TIMEOUT = 240000; // 4 min per slow single table (e.g. SHIPMENT_STATUS)

/**
 * Sweep count(*) where domain_name=<domain> for every domain-scoped object and
 * upsert into otm_config_table.
 *
 * Robust against the earlier silent-drop bug:
 *  - each batch's returned TBL set is verified to EXACTLY match the requested
 *    chunk; any mismatch (wrong/missing rows) triggers a per-table fallback,
 *  - every request has a timeout so a slow table can't hang the whole sweep,
 *  - a final pass retries anything still missing or errored,
 *  - counts are keyed by table name in a Map (dedup is inherent).
 */
export async function sweepCounts(connectionId: number): Promise<{ tables: number; counted: number; missing: number }> {
  const tables = await listDomainTables();
  const dom = cfg.otm.domain;
  const countExpr = (t: string) => `select '${t}' TBL, count(*) CNT from ${t} where domain_name='${dom}'`;
  const counted = new Map<string, number>();

  const single = async (t: string) => {
    const r = await runQuery(countExpr(t), "R", SINGLE_TIMEOUT);
    if (r[0]?.CNT != null) counted.set(t, Number(r[0].CNT));
    else counted.set(t, -1);
  };

  for (let i = 0; i < tables.length; i += BATCH) {
    const chunk = tables.slice(i, i + BATCH);
    try {
      const rows = await runQuery(chunk.map(countExpr).join(" union all "), "R", BATCH_TIMEOUT);
      const got = new Set(rows.map((r) => r.TBL));
      const exact = rows.length === chunk.length && chunk.every((t) => got.has(t));
      if (!exact) throw new Error("batch coverage mismatch");
      for (const r of rows) counted.set(r.TBL, Number(r.CNT));
    } catch {
      for (const t of chunk) {
        try { await single(t); } catch { counted.set(t, -1); }
      }
    }
  }

  // retry pass: anything never counted or marked errored (-1)
  for (const t of tables) {
    if (!counted.has(t) || counted.get(t) === -1) {
      try { await single(t); } catch { /* leave missing */ }
    }
  }

  // upsert; coalesce keeps a user-edited category on re-sweep
  for (const t of tables) {
    const n = counted.get(t);
    await q(
      `insert into otm_config_table (connection_id, table_name, tms_row_count, category, last_swept_at)
       values ($1,$2,$3,$4, now())
       on conflict (connection_id, table_name)
       do update set tms_row_count = excluded.tms_row_count,
                     category = coalesce(otm_config_table.category, excluded.category),
                     last_swept_at = now()`,
      [connectionId, t, n == null || n < 0 ? null : n, classifyCategory(t)],
    );
  }

  const missing = tables.filter((t) => !counted.has(t) || counted.get(t) === -1).length;
  return { tables: tables.length, counted: counted.size, missing };
}
