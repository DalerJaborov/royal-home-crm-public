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

/**
 * Адреса разделов, а не карточек (apps/web/src/App.tsx): «новый объект», карта, старая ссылка
 * «все мои клиенты». Личности карточки в них нет, выдумать их нельзя — сторож их не трогает.
 * Живой ложный отказ 17.11.2026: «если файл отправлю, сможешь загрузить?» без инструментов,
 * ответ с [Новый объект](/properties/new) целиком заменялся отказом.
 */
const SECTION_PATHS = new Set(["/properties/new", "/properties/map", "/clients/all-mine"]);
/** Список раздела с фильтрами (`/properties?districtId=…`) — тоже не карточка. */
const SECTION_LIST = /^\/(?:clients|properties)\/?[?#]/;

/**
 * Записи, чей ответ после исполнения несёт номер карточки, взятый из базы, а не из аргументов
 * модели (propertyShortId из найденного объекта, shortId созданного клиента). Остальные записи
 * сюда не входят: add_client_note и book_showing собирают href из args.clientId.
 */
const TRUSTED_WRITE_RESULTS = new Set([
  "change_property_price", "change_property_status", "request_property_change", "complete_property_editing",
  "restore_property", "restore_client", "create_client",
]);

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
  const api = {
    observe(toolName: string, result: unknown): void {
      const value = record(result);
      if (value?.error) return;
      switch (toolName) {
        case "search_clients": for (const item of rows(result)) card(item, "clients"); break;
        case "search_properties": for (const item of rows(result)) card(item, "properties"); break;
        case "search_deals": relatedCards(result, true); break;
        case "get_upcoming_showings": relatedCards(result, false); break;
        case "find_clients": for (const item of rows(value?.items)) card(item, "clients"); break;
        case "find_properties_by_place":
          for (const item of rows(value?.items)) {
            card(item, "properties");
            add(record(record(item)?.seller)?.href, "clients");
          }
          break;
        case "find_property": for (const item of rows(value?.items)) card(item, "properties"); break;
        case "get_client_card":
          card(result, "clients");
          add(record(record(value?.nextShowing)?.property)?.href, "properties");
          break;
        case "get_client_last_call": card(value?.client, "clients"); break;
        case "get_property_card": card(result, "properties"); break;
        // Реестр строек (21.11.2026): ответ по объекту несёт href карточки.
        case "get_construction_registry": add(value?.href, "properties"); break;
        // Рынок (14.11.2026): ответ несёт shortId/href той карточки, о которой речь.
        case "market_property_price": card(result, "properties"); break;
        case "market_for_client": card(result, "clients"); break;
        case "get_property_work_status":
          card(result, "properties");
          for (const item of rows(value?.items)) card(item, "properties");
          break;
        // «Режим директора» (17.11.2026, tools/directorTools.ts): ссылки на объекты и клиентов из заявок.
        case "list_pending_requests":
          for (const section of ["changeRequests", "propertyDeleteRequests", "awaitingModeration"]) {
            for (const item of rows(record(value?.[section])?.items)) add(record(item)?.propertyHref, "properties");
          }
          for (const item of rows(record(value?.clientDeleteRequests)?.items)) add(record(item)?.clientHref, "clients");
          break;
        case "list_my_tasks":
          for (const item of [...rows(value?.tasks), ...rows(value?.overdue)].slice(0, MAX_ROWS)) task(item);
          break;
        // «Мозг компании» (17.11.2026, tools/brainReadTools.ts): строки несут client.href, как задачи.
        case "get_unworked":
          for (const item of [...rows(value?.overdueTasks), ...rows(value?.noContact), ...rows(value?.silentAfterShowing)].slice(0, MAX_ROWS)) task(item);
          break;
        case "get_my_day":
          for (const item of [
            ...rows(value?.showings), ...rows(value?.tasks), ...rows(value?.overdue),
            ...rows(value?.unacceptedLeads), ...rows(value?.missedCalls),
          ].slice(0, MAX_ROWS)) task(item);
          break;
        case "get_missed_calls":
          for (const item of rows(value?.items)) task(item);
          break;
        // Unknown tools, writes, errors and free-form knowledge cannot grant card identities.
      }
      // Исполненная запись из списка выше: номер карточки — из базы (17.11.2026, «измени цену ОБ-164»).
      if (value?.done === true && TRUSTED_WRITE_RESULTS.has(toolName)) {
        const done = record(value.result);
        card({ shortId: done?.propertyShortId }, "properties");
        card({ shortId: done?.clientShortId }, "clients");
        if (toolName === "create_client") card({ shortId: done?.shortId }, "clients");
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
        if (SECTION_PATHS.has(path) || SECTION_LIST.test(path)) continue;
        if (!paths.has(path)) return { ok: false, reason: "unverified_card_link" };
      }
      return { ok: true };
    },
    /**
     * НЕПОДТВЕРЖДЁННАЯ ССЫЛКА — ОБЫЧНЫМ ТЕКСТОМ, А НЕ ОТКАЗ НА ВЕСЬ ОТВЕТ (17.11.2026).
     * Журнал прода: 3 из 56 ответов Шабнам целиком заменялись отказом из-за одной ссылки —
     * «Покажи 2-комнатные до 400 000 с. в Сино», «изменить цену, объект 164…», «если файл
     * отправлю…». Сторож создан, чтобы выдуманная ссылка не ушла человеку ССЫЛКОЙ: здесь
     * markdown-ссылка без доказательства становится своей подписью, голый путь к карточке
     * убирается, а результат проверяется заново. null — очистить не вышло (кодировки, размер):
     * тогда остаётся прежний отказ.
     */
    sanitize(text: string): { text: string; removed: number } | null {
      if (text.length > MAX_REPLY) return null;
      let removed = 0;
      const tokenOk = (token: string): boolean => api.validate(token).ok;
      // Markdown-ссылка: цель проверяется отдельно, подпись остаётся текстом.
      let out = text.replace(/\[([^\]\n]*)\]\(([^)\n]*)\)/g, (whole: string, label: string, target: string) => {
        if (tokenOk(`(${target})`)) return whole;
        removed += 1;
        return label;
      });
      // Голый путь к карточке (и внешний адрес с ним) — убирается целиком.
      out = out.replace(/\S+/g, (token: string) => {
        if (tokenOk(token)) return token;
        removed += 1;
        return "";
      });
      if (removed === 0) return api.validate(out).ok ? { text: out, removed } : null;
      out = out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/[ \t]+([.,!?;:])/g, "$1").trim();
      if (!out || !api.validate(out).ok) return null;
      return { text: out, removed };
    },
  };
  return api;
}
