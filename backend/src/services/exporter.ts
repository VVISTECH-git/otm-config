import ExcelJS from "exceljs";
import { q } from "../db";

const HDR = { bold: true } as const;
const HDR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF1FD" } } as const;
const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } } as const;

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

/** Excel sheet names: <=31 chars, no []:*?/\, and unique. */
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
const HUMAN_COLS = [5, 6, 7, 8, 9, 11, 12]; // 1-based: user-maintained cells
const CAT_RANK: Record<string, number> = { Configuration: 0, Master: 1, Transactional: 2 };

/**
 * Build the config workbook in the KRAFT style:
 *  - a "Configuration Register" index sheet (one row per extracted object,
 *    grouped by Category as Functional Area; mechanical columns auto-filled,
 *    design columns left yellow for the team; each row links to its data sheet),
 *  - one data sheet per table in OTM column order.
 */
export async function buildWorkbook(connectionId: number, raw = false): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "otm-config-portal";
  wb.created = new Date();

  const tables = await q(
    `select r.table_name,
            count(*)::int          as records,
            max(t.category)        as category,
            max(t.tms_row_count)   as tms_rows
     from otm_config_record r
     left join otm_config_table t
       on t.connection_id = r.connection_id and t.table_name = r.table_name
     where r.connection_id = $1 and r.deleted = false
     group by r.table_name`,
    [connectionId],
  );

  const reg = wb.addWorksheet("Configuration Register");

  if (tables.rows.length === 0) {
    reg.getCell(1, 1).value = "No records stored yet — select tables and run an extraction first.";
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  const sorted = tables.rows.slice().sort(
    (a, b) => (CAT_RANK[a.category] ?? 9) - (CAT_RANK[b.category] ?? 9) || a.table_name.localeCompare(b.table_name),
  );

  // reserve data-sheet names up front so the register can link to them
  const used = new Set<string>(["configuration register"]);
  const nameOf = new Map<string, string>();
  for (const t of sorted) nameOf.set(t.table_name, sheetName(t.table_name, used));

  // --- Register header block ---
  REG_WIDTHS.forEach((w, i) => (reg.getColumn(i + 1).width = w));
  reg.mergeCells(1, 1, 1, REG_COLS.length);
  reg.getCell(1, 1).value = "Configuration Register — domain TMS";
  reg.getCell(1, 1).font = { bold: true, size: 14 };
  reg.mergeCells(2, 1, 2, REG_COLS.length);
  reg.getCell(2, 1).value =
    "LEGEND – Yellow cells are user-maintained (Business Rule, Configured Value, OTM Navigation Path, FRS Ref, Setup Method, Owner, Status). Each object links to its data sheet.";
  reg.getCell(2, 1).font = { italic: true, color: { argb: "FF616D7B" } };
  const hdr = reg.getRow(3);
  REG_COLS.forEach((c, i) => {
    const cell = hdr.getCell(i + 1);
    cell.value = c;
    cell.font = HDR;
    cell.fill = HDR_FILL as any;
  });
  reg.views = [{ state: "frozen", ySplit: 3 }];

  // --- Register rows ---
  let rn = 4;
  let id = 1;
  for (const t of sorted) {
    const sheet = nameOf.get(t.table_name)!;
    const row = reg.getRow(rn++);
    row.getCell(1).value = `CFG-${String(id++).padStart(3, "0")}`;
    row.getCell(2).value = t.category ?? "";
    const obj = row.getCell(3);
    obj.value = { text: t.table_name, hyperlink: `#'${sheet}'!A1` } as any;
    obj.font = { color: { argb: "FF3457D5" }, underline: true };
    row.getCell(4).value = t.table_name;
    row.getCell(10).value = Number(t.records);
    for (const ci of HUMAN_COLS) row.getCell(ci).fill = YELLOW as any;
  }

  // --- Data sheets, in the same order, OTM column order ---
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
