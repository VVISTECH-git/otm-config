// Build the KRAFT-style config workbook LOCALLY (this machine has plenty of RAM)
// by pulling data from the API in small pages, and write it to Downloads.
const ExcelJS = require("exceljs");

const API = process.env.API || "https://otm-config-api.onrender.com";
const OUT = process.env.OUT || "C:/Users/bhanu/Downloads/otm_config_TMS.xlsx";
const NOISE = new Set(["DOMAIN_NAME", "INSERT_DATE", "INSERT_USER", "UPDATE_DATE", "UPDATE_USER"]);
const CAT = { Configuration: 0, Master: 1, Transactional: 2 };
const REG_COLS = ["Config ID","Functional Area","OTM Object / Table","Configuration Item","Business Rule / Description","Configured Value / Setting","OTM Navigation Path","FRS Ref","Setup Method","Records","Owner","Status"];
const REG_WIDTHS = [12,22,28,26,34,30,34,10,14,9,16,14];
const HUMAN = [5,6,7,8,9,11,12];
const HDR_FILL = { type:"pattern", pattern:"solid", fgColor:{argb:"FFEDF1FD"} };
const YELLOW = { type:"pattern", pattern:"solid", fgColor:{argb:"FFFFF2CC"} };

async function getJSON(path){ const r=await fetch(API+path); if(!r.ok) throw new Error("HTTP "+r.status+" "+path); return r.json(); }
function sheetName(name, used){ let b=name.slice(0,31).replace(/[\\/?*[\]:]/g,"_"); let n=b,i=1; while(used.has(n.toLowerCase())) n=b.slice(0,28)+"_"+(++i); used.add(n.toLowerCase()); return n; }

(async () => {
  console.log("fetching table list…");
  const list = await getJSON("/api/records/list");
  list.sort((a,b)=>(CAT[a.category]??9)-(CAT[b.category]??9)||a.table_name.localeCompare(b.table_name));
  console.log("tables with records:", list.length, "; total records:", list.reduce((s,x)=>s+x.records,0));

  const used = new Set(["configuration register"]);
  const nameOf = new Map();
  for (const t of list) nameOf.set(t.table_name, sheetName(t.table_name, used));

  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: OUT, useSharedStrings:false, useStyles:true });
  wb.creator = "otm-config-portal (local)";

  // Register
  const reg = wb.addWorksheet("Configuration Register");
  REG_WIDTHS.forEach((w,i)=>reg.getColumn(i+1).width=w);
  reg.views=[{state:"frozen",ySplit:3}];
  let r=reg.addRow(["Configuration Register — domain TMS"]); r.getCell(1).font={bold:true,size:14}; r.commit();
  r=reg.addRow(["LEGEND – Yellow cells are user-maintained (Business Rule, Configured Value, OTM Navigation Path, FRS Ref, Setup Method, Owner, Status). Each object links to its data sheet."]); r.getCell(1).font={italic:true,color:{argb:"FF616D7B"}}; r.commit();
  r=reg.addRow(REG_COLS); r.eachCell(c=>{c.font={bold:true}; c.fill=HDR_FILL;}); r.commit();
  let id=1;
  for (const t of list){
    const row=reg.addRow([`CFG-${String(id++).padStart(3,"0")}`, t.category||"", null, t.table_name, null,null,null,null,null, t.records, null, null]);
    const o=row.getCell(3); o.value={text:t.table_name, hyperlink:`#'${nameOf.get(t.table_name)}'!A1`}; o.font={color:{argb:"FF3457D5"},underline:true};
    for (const ci of HUMAN) row.getCell(ci).fill=YELLOW;
    row.commit();
  }
  reg.commit();

  // Data sheets (paged fetch)
  for (const t of list){
    const cols0 = (t.column_order && t.column_order.length) ? t.column_order.filter(c=>!NOISE.has(c)) : null;
    let cols=cols0, ws=null, offset=0, PAGE=2000, wrote=0;
    for(;;){
      const { rows } = await getJSON(`/api/records/data?table=${encodeURIComponent(t.table_name)}&offset=${offset}&limit=${PAGE}`);
      if (!rows.length) break;
      if (!ws){
        if (!cols){ const seen=new Set(); cols=[]; for(const p of rows) for(const k of Object.keys(p)) if(!seen.has(k)){seen.add(k);cols.push(k);} cols=cols.filter(c=>!NOISE.has(c)); }
        ws=wb.addWorksheet(nameOf.get(t.table_name));
        cols.forEach((c,i)=>ws.getColumn(i+1).width=Math.min(45,Math.max(10,c.length+2)));
        ws.views=[{state:"frozen",ySplit:1}];
        const hr=ws.addRow(cols); hr.eachCell(c=>{c.font={bold:true}; c.fill=HDR_FILL;}); hr.commit();
      }
      for (const p of rows){ ws.addRow(cols.map(c=>p[c]??null)).commit(); wrote++; }
      offset += rows.length;
      if (rows.length < PAGE) break;
    }
    console.log("  "+t.table_name+": "+wrote+" rows");
    if (ws) ws.commit();
  }

  await wb.commit();
  console.log("WROTE", OUT);
})().catch(e=>{ console.error("FAILED:", e); process.exit(1); });
