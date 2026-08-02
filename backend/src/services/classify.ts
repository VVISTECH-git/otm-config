export type Category = "Master" | "Configuration" | "Transactional";

/**
 * Rule-based first-guess classification of an OTM object into
 * Master / Configuration / Transactional. Transparent, adjustable, and
 * overridable per-table by the user (stored in otm_config_table.category).
 */
export function classifyCategory(name: string): Category {
  const T = name.toUpperCase();
  const any = (...res: RegExp[]) => res.some((re) => re.test(T));

  // 1) Warehouse / BI / logs / integration / audit / runtime -> Transactional
  if (any(/^W_/, /^D_/, /^F_/, /^E_KPI/, /^E_LOAD/, /^E_ORDER/, /^E_SHIPMENT/, /^E_FTI/, /^E_PARAMETER/, /_MV$/, /_G$/)) return "Transactional";
  if (any(/^I_/, /^IE_/, /^Q_/, /^JMS/, /^INT_MANAGED/)) return "Transactional";
  if (any(/AUDIT_TRAIL/, /AUDIT_DATA/, /AUDIT_EVENT/, /DATA_INFO/, /DATA_MODIFICATION_HISTORY/)) return "Transactional";
  if (any(/^LOGFILE/, /ERROR_LOG/, /ORACLE_ERROR/, /LOGIN_HISTORY/, /PASSWORD_HISTORY/, /_LOG$/, /_LOG_/, /PROCESS_LOG/, /^REPORT_LOG/, /^DIAG_/, /PERF_METRIC_DATA/, /^PERFM_/, /^FTI_LOAD/, /ETL_STAGING/, /PROCESS_CONTROL/, /^BATCH_PROCESS/, /LONG_RUNNING_TASK/, /MIGRATION_INDEX/, /PATCH_LOG/, /AGENT_STATS/)) return "Transactional";

  // 2) Config that would otherwise be caught by the txn prefixes below
  if (any(/_PROFILE(_D|_DETAIL|_SET)?$/, /_PROFILE_/, /_LAYOUT/, /_TEMPLATE$/, /_SPEC$/, /_SPEC_/, /SAVED_QUERY/, /SAVED_CONDITION/, /FINDER_SET/, /SCREEN_LAYOUT/, /USER_MENU/, /RULE_SET/, /_RULE$/, /_RULE_/, /PARAMETER_SET/, /PLANNING_PARAMETER/, /OUT_XML_PROFILE/, /OUT_JSON_PROFILE/, /^ORDER_ROUTING/)) return "Configuration";

  // 3) Transactional business documents + lifecycle
  if (any(
    /^OB_/, /^ORDER_RELEASE/, /^ORDER_MOVEMENT/, /^OMR/, /^SHIPMENT/, /^SHIP_GROUP/, /^SHIP_UNIT/, /^S_SHIP_UNIT/, /^S_EQUIPMENT/, /^SS_/, /^OBS_/, /^ORS_/, /^OR_STOP/, /^OR_EQUIPMENT/, /^BULK_/, /^ALLOCATION/, /^APPOINTMENT/, /^INVOICE/, /^VOUCHER/, /BILLABLE_TRANSACTION/, /^WORK_INVOICE/, /^WORK_ASSIGNMENT/, /^JOB(_|$)/, /^CLAIM/, /^QUOTE/, /^CONSOL/, /TENDER_COLLAB/, /SERVPROV_TENDER/, /^DM_TRANSACTION/, /GOODS_IN_TRANSIT/, /^ROUTE_INSTANCE/, /^DEVICE/, /TRACKING_LOCATION_RT/, /^VISIBILITY_/,
    /^SKU_(TRANSACTION|EVENT|QUANTITY|STATUS|COST|LEVEL|TEXT|DESCRIPTOR|INVOLVED)/, /^LNM_/, /^CR_/, /^P_(SHIPMENT|BID|SOLUTION|PROJECT|S_SHIP|RULE|LANE|LOCATION_GROUP|CRT)/, /^RATE_LOAD/, /^CAPACITY_(USAGE|COMMITMENT)/, /^COMMIT_/,
    /GTM_TRANSACTION/, /^GTM_TRANS_/, /GTM_TRANSLINE/, /^GTM_TR_/, /GTM_DECL_MESSAGE/, /^GTM_CAMPAIGN/, /^GTM_CA_LINE/, /GTM_TIP_INVENTORY/, /GTM_TIP_INV_/, /GTM_TIP_AUTH/, /GTM_PARTY_SCREENING/, /GTM_PARTY_LAST_SCREEN/, /^GTM_AUDIT/, /GTM_DATA_LOAD/, /^LD_SCREENING/, /^ESG_ACTIVITY/, /EMISSION_ALLOC/, /^FORECAST_ORDER/, /^DRS_REQUEST/,
    /NOTIFY_(REQUEST|EXCEPTION)/, /^MAIL_(AUDIT|BLOCKED|QUOTA|GROUP_QUOTA|BLOCK)/, /_STATUS_HISTORY/, /^ORDER_SCHEDULE/, /POWER_UNIT_STATUS/, /DRIVER_(ASSIGNMENT|HOS_RULE_STATE|CALENDAR_EVENT|STATUS)/, /^HOS_DAILY_SUMMARY/
  )) return "Transactional";

  // 4) Master data — core business entities
  if (any(/^LOCATION/, /^CORPORATION/, /^CONTACT/, /^SERVPROV/, /^CUSTOMER/, /^BUYER/, /^SHIPPING_AGENT/, /^DRIVER/, /^POWER_UNIT/, /^EQUIPMENT$/, /^VEHICLE/, /^VESSEL/, /^ITEM$/, /^ITEM_/, /^PACKAGED_ITEM/, /^PARTNER_ITEM/, /^COMMODITY/, /^SKU$/, /^GTM_ITEM/, /^GTM_PARTY/, /^GTM_PRODUCT_GROUP/, /^GTM_PROD_CLASS/, /^GTM_DENIED_PARTY/, /^GTM_STRUCTURE/, /^GTM_STR_/, /^GTM_BOND/, /^GTM_LICENSE/, /^GTM_REGISTRATION/, /^HAZMAT/, /^HAZ_/, /^ASSET_/, /^LEASE_/)) return "Master";

  // 5) Reference / lookup codes -> Master
  if (any(/^COUNTRY/, /^CURRENCY/, /^UOM/, /^TIME_ZONE/, /^RATE_CLASSIFICATION/, /^TRANSPORT_MODE/, /^SCAC/, /^SPLC/, /^STATION_CODE/, /^JUNCTION_CODE/, /^ERPC/, /^NMFC/, /^HTS/, /^SITC/, /^STCC/, /^X_(UN_LOC|UPS|OAG|IATA|VOY|GEO)/, /^GEO_.*POINT/, /^AAR_/, /UDC_CLASSIFICATION/, /^INCO_TERM$/)) return "Master";

  // 6) default -> Configuration
  return "Configuration";
}
