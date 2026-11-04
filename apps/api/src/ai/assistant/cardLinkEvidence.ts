/** Evidence of card identity, NOT a validator of free-text prices, names or other facts.
 * Only feed server tool results from the current turn. Never history, prompts or arguments.
 */
const MAX_PATHS = 128;
const MAX_ROWS = 128;
const MAX_REPLY = 32_000;
type Kind = "clients" | "properties";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const rows = (value: unknown): unknown[] => Array.isArray(value) ? value.slice(0, MAX_ROWS) : [];
const identifier = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

export type CardLinkValidation = { ok: true } | { ok: false; reason: "unverified_card_link" | "response_too_large" };

export function createCardLinkEvidence() {
  const paths = new Set<string>();
  function add(path: unknown, kind: Kind) {
    if (paths.size >= MAX_PATHS || typeof path !== "string") return;
    const prefix = `/${kind}/`;
    if (path.startsWith(prefix) && identifier(path.slice(prefix.length))) paths.add(path);
  }
  function card(value: unknown, kind: Kind) {
    const item = record(value);
    if (!item || item.error) return;
    if (identifier(item.id)) add(`/${kind}/${item.id}`, kind);
    if (Number.isSafeInteger(item.shortId) && Number(item.shortId) > 0) add(`/${kind}/${item.shortId}`, kind);
    add(item.href, kind);
  }
  function relatedCards(result: unknown, includeClient: boolean) {
    for (const row of rows(result)) {
      const item = record(row);
      if (!item || item.error) continue;
      card({ shortId: item.propertyShortId }, "properties");
      if (includeClient) card({ shortId: item.clientShortId }, "clients");
    }
  }
  function task(value: unknown) {
    const item = record(value);
    if (!item) return;
    // These nested objects are typed server presentation fields, not arbitrary text.
    add(record(item.client)?.href, "clients");
    add(record(item.property)?.href, "properties");
  }
  return {
    observe(toolName: string, result: unknown): void {
      const value = record(result);
      if (value?.error) return;
      switch (toolName) {
        case "search_clients": for (const item of rows(result)) card(item, "clients"); break;
        case "search_properties": for (const item of rows(result)) card(item, "properties"); break;
        case "search_deals": relatedCards(result, true); break;
        case "get_upcoming_showings": relatedCards(result, false); break;
        case "find_clients": for (const item of rows(value?.items)) card(item, "clients"); break;
        case "find_property": for (const item of rows(value?.items)) card(item, "properties"); break;
        case "get_client_card":
          card(result, "clients");
          add(record(record(value?.nextShowing)?.property)?.href, "properties");
          break;
        case "get_client_last_call": card(value?.client, "clients"); break;
        case "get_property_card": card(result, "properties"); break;
        case "get_property_work_status":
          card(result, "properties");
          for (const item of rows(value?.items)) card(item, "properties");
          break;
        case "list_my_tasks":
          for (const item of [...rows(value?.tasks), ...rows(value?.overdue)].slice(0, MAX_ROWS)) task(item);
          break;
        // Unknown tools, writes, errors and free-form knowledge cannot grant card identities.
      }
    },
    validate(text: string): CardLinkValidation {
      if (text.length > MAX_REPLY) return { ok: false, reason: "response_too_large" };
      // Detect encoded route names/slashes as well. Repeated encoding is deliberately
      // bounded; undecoded '%' in a candidate cannot equal an approved canonical path.
      let scanned = text;
      for (let round = 0; round < 3; round++) scanned = scanned.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
      scanned = scanned.replace(/\\/g, "/");
      scanned = scanned.replace(/(^|[\s([<"'`])((?:clients|properties)\/)/gi, "$1/$2");
      const links = /\/(?:clients|properties)(?=$|[^A-Za-z0-9_-])[^\s<>()[\]"'`{}]*/gi;
      for (const match of scanned.matchAll(links)) {
        const path = match[0].replace(/[.,!;:]+$/, "");
        const prefix = scanned.slice(0, match.index);
        // A matching ID does not authorize an external host or protocol-relative link.
        if (/(?:[a-z][a-z0-9+.-]*:)?\/\/[^\s<>()[\]"'`{}]*$/i.test(prefix)) return { ok: false, reason: "unverified_card_link" };
        if (path === "/clients" || path === "/clients/" || path === "/properties" || path === "/properties/") continue;
        if (!paths.has(path)) return { ok: false, reason: "unverified_card_link" };
      }
      return { ok: true };
    },
  };
}
