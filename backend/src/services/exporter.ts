import ExcelJS from "exceljs";
import { Writable } from "stream";
import { q } from "../db";

const HDR = { bold: true } as const;
const HDR_FILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEDF1FD" } } as const;
const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } } as const;

const NOISE = new Set(["DOMAIN_NAME", "INSERT_DATE", "INSERT_USER", "UPDATE_DATE", "UPDATE_USER"]);
const PAGE = 2000; // rows fetched per DB round-trip (keeps memory flat)

function sheetName(name: string, used: Set<string>): string {
  let base = name.slice(0, 31).replace(/[\\/?*[\]:]/g, "_");
  let n = base;
  let i = 1;
  while (used.has(n.toLowerCase())) n = base.slice(0, 28) + "_" + ++i;
  used.add(n.toLowerCase());
  return n;
}

/** Columns from OTM's stored DDL order (minus audit/domain noise unless raw). */
function columnsFor(otmOrder: string[] | null, sampleKeys: string[], raw: boolean): string[] {
  const base = otmOrder && otmOrder.length ? otmOrder.slice() : sampleKeys;
  return raw ? base : base.filter((k) => !NOISE.has(k));
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
 * Stream the KRAFT-style config workbook to `out` with FLAT memory:
 * ExcelJS streaming writer + per-table reads paginated at PAGE rows, so peak
 * memory is ~one page regardless of table size or total volume. Handles the
 * large extractions that OOM the in-memory (and even naive-streaming) builder.
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

  // Register
  REG_WIDTHS.forEach((w, i) => (reg.getColumn(i + 1).width = w));
  reg.views = [{ state: "frozen", ySplit: 3 }];
  const rT = reg.addRow(["Configuration Register — domain TMS"]);
  rT.getCell(1).font = { bold: true, size: 14 };
  rT.commit();
  const rL = reg.addRow([
    "LEGEND – Yellow cells are user-maintained (Business Rule, Configured Value, OTM Navigation Path, FRS Ref, Setup Method, Owner, Status). Each object links to its data sheet.",
  ]);
  rL.getCell(1).font = { italic: true, color: { argb: "FF616D7B" } };
  rL.commit();
  const rH = reg.addRow(REG_COLS);
  rH.eachCell((c) => { c.font = HDR; c.fill = HDR_FILL as any; });
  rH.commit();
  let id = 1;
  for (const t of sorted) {
    const row = reg.addRow([
      `CFG-${String(id++).padStart(3, "0")}`, t.category ?? "", null, t.table_name,
      null, null, null, null, null, Number(t.records), null, null,
    ]);
    const obj = row.getCell(3);
    obj.value = { text: t.table_name, hyperlink: `#'${nameOf.get(t.table_name)}'!A1` } as any;
    obj.font = { color: { argb: "FF3457D5" }, underline: true };
    for (const ci of HUMAN_COLS) row.getCell(ci).fill = YELLOW as any;
    row.commit();
  }
  reg.commit();

  // Data sheets — paginated (flat memory)
  for (const t of sorted) {
    const meta = await q(
      `select column_order from otm_config_table where connection_id=$1 and table_name=$2`,
      [connectionId, t.table_name],
    );
    const otmOrder = (meta.rows[0]?.column_order as string[] | null) ?? null;

    let cols: string[] | null = null;
    let ws: ExcelJS.Worksheet | null = null;
    let offset = 0;
    for (;;) {
      const batch = await q(
        `select payload from otm_config_record
         where connection_id=$1 and table_name=$2 and deleted=false
         order by pk_value limit $3 offset $4`,
        [connectionId, t.table_name, PAGE, offset],
      );
      if (batch.rows.length === 0) break;

      if (!cols) {
        const sample: string[] = [];
        const seen = new Set<string>();
        for (const r of batch.rows) for (const k of Object.keys(r.payload)) if (!seen.has(k)) { seen.add(k); sample.push(k); }
        cols = columnsFor(otmOrder, sample, raw);
        ws = wb.addWorksheet(nameOf.get(t.table_name)!);
        cols.forEach((c, i) => (ws!.getColumn(i + 1).width = Math.min(45, Math.max(10, c.length + 2))));
        ws.views = [{ state: "frozen", ySplit: 1 }];
        const hr = ws.addRow(cols);
        hr.eachCell((c) => { c.font = HDR; c.fill = HDR_FILL as any; });
        hr.commit();
      }
      for (const r of batch.rows) {
        const p = r.payload as Record<string, unknown>;
        ws!.addRow(cols.map((c) => p[c] ?? null)).commit();
      }
      offset += batch.rows.length;
      if (batch.rows.length < PAGE) break;
    }
    if (ws) ws.commit();
  }

  await wb.commit();
}
