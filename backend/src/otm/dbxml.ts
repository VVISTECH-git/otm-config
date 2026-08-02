import { XMLParser } from "fast-xml-parser";
import { cfg } from "../config";

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });

function endpoint(): string {
  return `${cfg.otm.baseUrl}/GC3/glog.integration.servlet.DBXMLServlet?command=xmlExport`;
}

function authHeader(): string {
  return "Basic " + Buffer.from(`${cfg.otm.user}:${cfg.otm.pass}`).toString("base64");
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Run a single SQL SELECT via the OTM DBXMLServlet (command=xmlExport) and
 * return the rows as plain objects (attribute name -> value string).
 *
 * NOTE: the servlet honors ONE <Query> block per request. Each result row is
 * emitted as a self-closing element named after RootName, with columns as
 * attributes. An empty result comes back as the literal text "NO DATA".
 */
export async function runQuery(
  sql: string,
  rootName = "Row",
): Promise<Record<string, string>[]> {
  const body =
    `<sql2xml><Query><RootName>${rootName}</RootName>` +
    `<Statement>${escapeXml(sql)}</Statement></Query></sql2xml>`;

  const res = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "text/xml", Authorization: authHeader() },
    body,
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`DBXMLServlet HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (text.includes("NO DATA")) return [];
  if (/ORA-\d{5}/.test(text)) {
    throw new Error(`OTM SQL error: ${(text.match(/ORA-\d{5}[^<]*/) ?? [""])[0]}`);
  }

  const doc = parser.parse(text) as Record<string, any>;
  const ts = doc?.["dbxml:xml2sql"]?.["dbxml:TRANSACTION_SET"];
  if (!ts) return [];
  const rows = ts[rootName];
  if (rows == null) return [];
  return (Array.isArray(rows) ? rows : [rows]) as Record<string, string>[];
}
