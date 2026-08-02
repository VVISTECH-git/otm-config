import ExcelJS from "exceljs";
import { q } from "../db";

const HDR = { bold: true } as const;
const HDR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF1FD" } } as const;

// Always-noise columns hidden in the curated view (audit + constant domain).
const NOISE = new Set(["DOMAIN_NAME", "INSERT_DATE", "INSERT_USER", "UPDATE_DATE", "UPDATE_USER"]);

type Rec = { payload: Record<string, unknown> };

/**
 * Curate columns for a readable config document, PRESERVING OTM's native
 * column order (DDL order, from otm_config_table.column_order):
 *  - order every column by OTM's column_id sequence,
 *  - (unless raw) drop audit/domain noise and columns empty across every row,
 *  - never reorder beyond OTM's own sequence.
 */
function curateColumns(records: Rec[], raw: boolean, otmOrder: string[] | null): string[] {
  const all: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r.payload)) if (!seen.has(k)) { seen.add(k); all.push(k); }
  }

  // Order by OTM's DDL sequence; any key not in it (shouldn't happen) goes last.
  let ordered = all;
  if (otmOrder && otmOrder.length) {
    const idx = new Map(otmOrder.map((c, i) => [c, i]));
    ordered = all.slice().sort((a, b) => (idx.get(a) ?? 1e9) - (idx.get(b) ?? 1e9));
  }
  if (raw) return ordered;

  const nonEmpty = new Set<string>();
  for (const r of records) {
    for (const k of ordered) {
      const v = r.payload[k];
      if (v != null && String(v).trim() !== "") nonEmpty.add(k);
    }
  }
  let cols = ordered.filter((k) => !NOISE.has(k) && nonEmpty.has(k));
  if (cols.length === 0) cols = ordered.filter((k) => !NOISE.has(k));
  if (cols.length === 0) cols = ordered;
  return cols; // OTM order preserved
}

/**
 * Build the standard config workbook from extracted records: a Summary sheet +
 * one curated sheet per table. `raw` keeps every column.
 */
export async function buildWorkbook(connectionId: number, raw = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "otm-config-portal";
  wb.created = new Date();

  const tables = await q(
    `select r.table_name,
            count(*)::int          as records,
            max(t.category)        as category,
            max(t.tms_row_count)   as tms_rows,
            max(t.last_fetched_at) as last_fetched
     from otm_config_record r
     left join otm_config_table t
       on t.connection_id = r.connection_id and t.table_name = r.table_name
     where r.connection_id = $1 and r.deleted = false
     group by r.table_name
     order by r.table_name`,
    [connectionId],
  );

  const summary = wb.addWorksheet("Summary");
  summary.columns = [
    { header: "Table", key: "t", width: 40 },
    { header: "Category", key: "c", width: 16 },
    { header: "Records extracted", key: "n", width: 18 },
    { header: "TMS rows", key: "tms", width: 14 },
    { header: "Last fetched (UTC)", key: "lf", width: 22 },
  ];
  summary.getRow(1).font = HDR;
  summary.getRow(1).eachCell((c) => (c.fill = HDR_FILL as any));

  if (tables.rows.length === 0) {
    summary.addRow({ t: "No records stored yet — select tables and run an extraction first." });
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  for (const row of tables.rows) {
    summary.addRow({
      t: row.table_name,
      c: row.category ?? "",
      n: Number(row.records),
      tms: row.tms_rows == null ? "" : Number(row.tms_rows),
      lf: row.last_fetched ? new Date(row.last_fetched).toISOString().slice(0, 19).replace("T", " ") : "",
    });
  }
  summary.addRow({});
  summary.addRow({ t: raw ? "All columns shown (raw)." : "Columns curated: audit & empty columns hidden. Append ?raw=true for all columns." });

  const used = new Set<string>(["summary"]);
  for (const row of tables.rows) {
    const recs = await q(
      `select payload from otm_config_record
       where connection_id=$1 and table_name=$2 and deleted=false order by pk_value`,
      [connectionId, row.table_name],
    );

    const meta = await q(
      `select column_order from otm_config_table where connection_id=$1 and table_name=$2`,
      [connectionId, row.table_name],
    );
    const otmOrder = (meta.rows[0]?.column_order as string[] | null) ?? null;
    const cols = curateColumns(recs.rows as Rec[], raw, otmOrder);
    const ws = wb.addWorksheet(sheetName(row.table_name, used));
    ws.columns = cols.map((c) => ({ header: c, key: c, width: Math.min(45, Math.max(10, c.length + 2)) }));
    if (cols.length) {
      ws.getRow(1).font = HDR;
      ws.getRow(1).eachCell((c) => (c.fill = HDR_FILL as any));
      ws.views = [{ state: "frozen", ySplit: 1 }];
    }
    for (const r of recs.rows) {
      const p = r.payload as Record<string, unknown>;
      ws.addRow(Object.fromEntries(cols.map((c) => [c, p[c] ?? null])));
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Excel sheet names: <=31 chars, no []:*?/\, and unique. */
function sheetName(name: string, used: Set<string>): string {
  let base = name.slice(0, 31).replace(/[\\/?*[\]:]/g, "_");
  let n = base;
  let i = 1;
  while (used.has(n.toLowerCase())) n = base.slice(0, 28) + "_" + ++i;
  used.add(n.toLowerCase());
  return n;
}
