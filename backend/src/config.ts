import "dotenv/config";

export const cfg = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? "",
  otm: {
    baseUrl: (process.env.OTM_BASE_URL ?? "").replace(/\/+$/, ""),
    user: process.env.OTM_USER ?? "",
    pass: process.env.OTM_PASS ?? "",
    domain: process.env.OTM_DOMAIN ?? "TMS",
  },
};

export function assertConfig(): string[] {
  const missing: string[] = [];
  if (!cfg.databaseUrl) missing.push("DATABASE_URL");
  if (!cfg.otm.baseUrl) missing.push("OTM_BASE_URL");
  if (!cfg.otm.user) missing.push("OTM_USER");
  if (!cfg.otm.pass) missing.push("OTM_PASS");
  return missing;
}
