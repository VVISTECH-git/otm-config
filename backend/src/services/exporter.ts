import ExcelJS from "exceljs";
import { Writable } from "stream";
import { q } from "../db";

const HDR = { bold: true } as const;
const HDR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF1FD" } } as const;
const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } } as const;

const NOISE = new Set(["DOMAIN_NAME", "INSERT_DATE", "INSERT_USER", "UPDATE_DATE", "UPDATE_USER"]);

type Rec = { payload: Record<string, unknown> };

function curateColumns(records: Rec[], raw: boolean, otmOrder: string[] | null): string[] {
  const all: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r.payload)) if (!seen.has(k)) { seen.add(k); all.push(k); }
  }
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
  return cols;
}

function sheetName(name: string, used: Set<string>): string {
  let base = name.slice(0, 31).replace(/[\\/?*[\]:]/g, "_");
  let n = base;
  let i = 1;
  while (used.has(n.toLowerCase())) n = base.slice(0, 28) + "_" + ++i;
  used.add(n.toLowerCase());
  return n;
}

const REG_COLS = [
  "Config ID", "Functional Area", "OTM Object / Table", "Configuration Item",
  "Business Rule / Description", "Configured Value / Setting", "OTM Navigation Path",
  "FRS Ref", "Setup Method", "Records", "Owner", "Status",
];
const REG_WIDTHS = [12, 22, 28, 26, 34, 30, 34, 10, 14, 9, 16, 14];
const HUMAN_COLS = [5, 6, 7, 8, 9, 11, 12];
const CAT_RANK: Record<string, number> = { Configuration: 0, Master: 1, Transactional: 2 };

/**
 * Stream the KRAFT-style config workbook to `out` with BOUNDED memory:
 * ExcelJS streaming WorkbookWriter flushes each sheet/row as it's committed,
 * and only one table's records are held at a time. Handles large volumes that
 * the in-memory builder OOMs on. (Register index sheet + one data sheet per
 * table in OTM column order.)
 */
export async function streamWorkbook(connectionId: number, out: Writable, raw = false): Promise<void> {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: out, useSharedStrings: false, useStyles: true });
  wb.creator = "otm-config-portal";

  const tables = await q(
    `select r.table_name, count(*)::int as records, max(t.category) as category
     from otm_config_record r
     left join otm_config_table t on t.connection_id=r.connection_id and t.table_name=r.table_name
     where r.connection_id=$1 and r.deleted=false
     group by r.table_name`,
    [connectionId],
  );

  const reg = wb.addWorksheet("Configuration Register");
  if (tables.rows.length === 0) {
    reg.addRow(["No records stored yet — select tables and run an extraction first."]).commit();
    reg.commit();
    await wb.commit();
    return;
  }

  const sorted = tables.rows.slice().sort(
    (a, b) => (CAT_RANK[a.category] ?? 9) - (CAT_RANK[b.category] ?? 9) || a.table_name.localeCompare(b.table_name),
  );
  const used = new Set<string>(["configuration register"]);
  const nameOf = new Map<string, string>();
  for (const t of sorted) nameOf.set(t.table_name, sheetName(t.table_name, used));

  // Register header (no merges — keep streaming-safe)
  REG_WIDTHS.forEach((w, i) => (reg.getColumn(i + 1).width = w));
  reg.views = [{ state: "frozen", ySplit: 3 }];
  const rTitle = reg.addRow(["Configuration Register — domain TMS"]);
  rTitle.getCell(1).font = { bold: true, size: 14 };
  rTitle.commit();
  const rLeg = reg.addRow([
    "LEGEND – Yellow cells are user-maintained (Business Rule, Configured Value, OTM Navigation Path, FRS Ref, Setup Method, Owner, Status). Each object links to its data sheet.",
  ]);
  rLeg.getCell(1).font = { italic: true, color: { argb: "FF616D7B" } };
  rLeg.commit();
  const rHead = reg.addRow(REG_COLS);
  rHead.eachCell((c) => { c.font = HDR; c.fill = HDR_FILL as any; });
  rHead.commit();

  let id = 1;
  for (const t of sorted) {
    const sheet = nameOf.get(t.table_name)!;
    const row = reg.addRow([
      `CFG-${String(id++).padStart(3, "0")}`, t.category ?? "", null, t.table_name,
      null, null, null, null, null, Number(t.records), null, null,
    ]);
    const obj = row.getCell(3);
    obj.value = { text: t.table_name, hyperlink: `#'${sheet}'!A1` } as any;
    obj.font = { color: { argb: "FF3457D5" }, underline: true };
    for (const ci of HUMAN_COLS) row.getCell(ci).fill = YELLOW as any;
    row.commit();
  }
  reg.commit();

  // Data sheets — one table at a time (bounded memory)
  for (const t of sorted) {
    const recs = await q(
      `select payload from otm_config_record
       where connection_id=$1 and table_name=$2 and deleted=false order by pk_value`,
      [connectionId, t.table_name],
    );
    const meta = await q(
      `select column_order from otm_config_table where connection_id=$1 and table_name=$2`,
      [connectionId, t.table_name],
    );
    const otmOrder = (meta.rows[0]?.column_order as string[] | null) ?? null;
    const cols = curateColumns(recs.rows as Rec[], raw, otmOrder);

    const ws = wb.addWorksheet(nameOf.get(t.table_name)!);
    cols.forEach((c, i) => (ws.getColumn(i + 1).width = Math.min(45, Math.max(10, c.length + 2))));
    ws.views = [{ state: "frozen", ySplit: 1 }];
    const hr = ws.addRow(cols);
    hr.eachCell((c) => { c.font = HDR; c.fill = HDR_FILL as any; });
    hr.commit();
    for (const r of recs.rows) {
      const p = (r as Rec).payload;
      ws.addRow(cols.map((c) => p[c] ?? null)).commit();
    }
    ws.commit();
  }

  await wb.commit();
}
