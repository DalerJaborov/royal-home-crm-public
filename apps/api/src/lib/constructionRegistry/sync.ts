/**
 * ЗАБОР РЕЕСТРА РАЗРЕШЁННЫХ СТРОЕК memor.pro (20.11.2026, решение владельца: раз в неделю, только для сотрудников).
 *
 * Вежливость к чужому серверу (эндпоинт не документирован): один запрос списка, страницы объектов только
 * для НОВЫХ и ИЗМЕНИВШИХСЯ строк и только жилых, по одной с паузой, без параллели, понятный User-Agent,
 * таймаут. Контакты не берём и не храним. Любой отказ — в журнал ошибок (logSystemError), а не молча.
 *
 * Сторож здравого смысла: список не массив, пустой или короче половины прежнего активного числа —
 * ничего не применяем, пишем ошибку. Иначе сбой чужого сайта «стёр» бы реестр у нас.
 *
 * Первый забор — «нулевая точка»: смену цвета и уведомления не создаём (сравнивать не с чем).
 */
import { normalizeDeveloperName, REGISTRY_COLOR_LABEL } from "@royal-home/shared";
import type { RegistryColor } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { logSystemError } from "../systemError.js";
import { notifyFeedOnly } from "../notifications.js";
import { propertyOwnerAgentId } from "../propertyOwner.js";
import { autoLinkAllProperties } from "./link.js";
import { COLOR_DB } from "./view.js";
import { parseRegistryList, parseRegistryProjectPage, registryProjectUrl, REGISTRY_LIST_URL, type ParsedList, type ParsedProjectPage } from "./parse.js";

export const REGISTRY_USER_AGENT = "RoyalHomeCRM-registry-sync/1.0 (internal use; weekly)";
const LIST_TIMEOUT_MS = 30_000;
const PAGE_TIMEOUT_MS = 20_000;
const LIST_MAX_BYTES = 5_000_000;
const PAGE_MAX_BYTES = 1_000_000;
/** Пауза между страницами объектов, мс (1–2 с по решению разведки). */
export const PAGE_PAUSE_MS = 1500;
/** Потолок страниц за один забор: первый забор — все жилые (~360), дальше единицы. */
export const DETAILS_PER_RUN_CAP = 450;
/** Список короче этой доли прежнего активного числа — не применяем. */
export const MIN_SHRINK_RATIO = 0.5;
/** Сторож вёрстки: после стольких страниц считаем долю «без узнаваемых данных»; больше доли — разметка источника изменилась. */
export const LAYOUT_MIN_SAMPLE = 10;
export const LAYOUT_BAD_RATIO = 0.5;
/** Не разобрано больше этой доли строк списка — не применяем. */
export const MAX_SKIPPED_RATIO = 0.1;
/** Исчезло больше этой доли прежних проектов за один забор — не применяем (ложная тревога лучше затёртого реестра). */
export const MAX_GONE_RATIO = 0.2;
/** Незавершённый забор моложе этого считается идущим (замок между процессами api и worker). */
const RUN_LOCK_MS = 2 * 3_600_000;

export interface RegistrySource {
  fetchList(): Promise<unknown>;
  fetchPage(url: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

async function fetchText(url: string, timeoutMs: number, maxBytes: number): Promise<string> {
  const res = await fetch(url, {
    headers: { "User-Agent": REGISTRY_USER_AGENT, Accept: "application/json, text/html;q=0.9" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Реестр ответил ${res.status}`);
  const body = await res.text();
  if (body.length > maxBytes) throw new Error("Ответ реестра слишком большой");
  return body;
}

export const liveRegistrySource: RegistrySource = {
  async fetchList() {
    const body = await fetchText(REGISTRY_LIST_URL, LIST_TIMEOUT_MS, LIST_MAX_BYTES);
    try {
      return JSON.parse(body) as unknown;
    } catch {
      throw new Error("Реестр вернул не JSON");
    }
  },
  fetchPage: (url) => fetchText(url, PAGE_TIMEOUT_MS, PAGE_MAX_BYTES),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export async function loadRegistrySettings(): Promise<{ enabled: boolean; notify: boolean }> {
  try {
    const row = await prisma.settings.findUnique({
      where: { id: "singleton" },
      select: { constructionRegistryEnabled: true, constructionRegistryNotify: true },
    });
    return { enabled: row?.constructionRegistryEnabled !== false, notify: row?.constructionRegistryNotify !== false };
  } catch {
    return { enabled: true, notify: true };
  }
}

export interface RegistrySyncResult {
  ok: boolean;
  skipped?: "disabled" | "already-running";
  fetched: number;
  created: number;
  changed: number;
  removed: number;
  detailsFetched: number;
  linked: number;
  notified: number;
  /** Строки списка, которые не взяты (чужой домен адреса). */
  rowsSkipped: number;
  error?: string;
}

let running = false;

function empty(partial: Partial<RegistrySyncResult> = {}): RegistrySyncResult {
  return { ok: false, fetched: 0, created: 0, changed: 0, removed: 0, detailsFetched: 0, linked: 0, notified: 0, rowsSkipped: 0, ...partial };
}

/** Сторож здравого смысла: можно ли применять пришедший список. null — можно, иначе причина отказа. */
export function sanityRefusal(parsed: ParsedList, previousActive: number): string | null {
  if (parsed.items.length === 0) return "Реестр вернул пустой список";
  // Много строк не разобралось: формат источника, скорее всего, изменился, применять половину нельзя.
  if (parsed.skipped > Math.max(5, (parsed.items.length + parsed.skipped) * MAX_SKIPPED_RATIO)) {
    return `Не разобрано ${parsed.skipped} строк из ${parsed.items.length + parsed.skipped}: формат реестра, возможно, изменился, ничего не применено`;
  }
  if (previousActive >= 20 && parsed.items.length < previousActive * MIN_SHRINK_RATIO) {
    return `Список реестра сократился с ${previousActive} до ${parsed.items.length} (меньше половины): сбой источника, ничего не применено`;
  }
  return null;
}

/**
 * Один полный забор. `source` подменяется в тестах. `trigger`: "cron" | "manual".
 * Не бросает: итог и ошибка возвращаются, ошибка пишется в журнал и в ConstructionSyncRun.
 */
export async function runConstructionRegistrySync(
  opts: { source?: RegistrySource; trigger?: "cron" | "manual"; now?: Date } = {},
): Promise<RegistrySyncResult> {
  const source = opts.source ?? liveRegistrySource;
  const trigger = opts.trigger ?? "cron";
  const now = opts.now ?? new Date();
  const settings = await loadRegistrySettings();
  // Выключенный рубильник останавливает и ночной забор, и ручной.
  if (!settings.enabled) return empty({ ok: true, skipped: "disabled" });
  if (running) return empty({ ok: true, skipped: "already-running" });
  running = true;
  const result = empty();
  let runIdForCatch: string | null = null;
  try {
    // Замок между процессами (api принимает ручной запуск, worker — ночной): забор моложе двух часов без итога считается идущим.
    const busy = await prisma.constructionSyncRun.count({ where: { finishedAt: null, startedAt: { gt: new Date(now.getTime() - RUN_LOCK_MS) } } });
    if (busy > 0) return empty({ ok: true, skipped: "already-running" });
    const run = await prisma.constructionSyncRun.create({ data: { trigger, startedAt: now }, select: { id: true } });
    runIdForCatch = run.id;
    const parsed = parseRegistryList(await source.fetchList());
    result.fetched = parsed.items.length;
    const previousActive = await prisma.constructionProject.count({ where: { removedAt: null } });
    const refusal = sanityRefusal(parsed, previousActive);
    if (refusal) throw new Error(refusal);
    if (parsed.skipped > 0) {
      void logSystemError("cron", `Реестр строек: не разобрано строк списка: ${parsed.skipped} из ${parsed.skipped + parsed.items.length}`);
    }

    const firstRun = previousActive === 0;
    const existing = await prisma.constructionProject.findMany({
      select: { id: true, sourceId: true, listHash: true, colorStatus: true, detailFetchedAt: true, removedAt: true, category: true },
      take: 20_000,
    });
    const bySource = new Map(existing.map((p) => [p.sourceId, p]));
    const developerIds = new Map<string, string>();
    const needPage: { sourceId: string; projectId: string; url: string; hash: string }[] = [];

    for (const item of parsed.items) {
      let url: string;
      try {
        url = registryProjectUrl(item.url || `${item.sourceId}/`);
      } catch {
        // Строка с адресом вне домена реестра: пропускаем и считаем, а не роняем весь забор.
        result.rowsSkipped += 1;
        continue;
      }
      // Без названия застройщика (или только «ҶДММ») общего застройщика не заводим: оценка по чужим проектам была бы выдумкой.
      const devKey = normalizeDeveloperName(item.customer) || `__без-названия__${item.sourceId}`;
      let developerId = developerIds.get(devKey);
      if (!developerId) {
        const dev = await prisma.constructionDeveloper.upsert({
          where: { nameNormalized: devKey },
          create: { nameNormalized: devKey, displayName: item.customer || "Без названия" },
          update: {},
          select: { id: true },
        });
        developerId = dev.id;
        developerIds.set(devKey, developerId);
      }
      const prev = bySource.get(item.sourceId);
      const colorDb = COLOR_DB[item.color];
      const baseData = {
        qaror: item.qaror,
        title: item.title,
        customer: item.customer,
        developerId,
        lat: item.lat,
        lng: item.lng,
        category: item.category,
        eduType: item.eduType,
        colorStatus: colorDb,
        isComplete: item.isComplete,
        hasCommission: item.hasCommission,
        sourceUrl: url,
        listHash: item.hash,
        lastSeenAt: now,
        removedAt: null,
      };
      // У жилого проекта новый хэш записываем только после успешного чтения страницы: иначе сбой страницы потерял бы изменение.
      const { listHash: omittedHash, ...baseWithoutHash } = baseData;
      void omittedHash;
      if (!prev) {
        const created = await prisma.constructionProject.create({
          data: { sourceId: item.sourceId, ...baseData, firstSeenAt: now, statusChangedAt: firstRun ? null : now },
          select: { id: true },
        });
        result.created += 1;
        await prisma.constructionStatusChange.create({ data: { projectId: created.id, fromColor: null, toColor: colorDb, changedAt: now, notifiedAt: now } });
        if (item.category === "residential") needPage.push({ sourceId: item.sourceId, projectId: created.id, url, hash: item.hash });
        continue;
      }
      const hashChanged = prev.listHash !== item.hash || prev.removedAt !== null;
      if (hashChanged) {
        const colorChanged = prev.colorStatus !== colorDb;
        await prisma.constructionProject.update({
          where: { id: prev.id },
          data: { ...(item.category === "residential" ? baseWithoutHash : baseData), ...(colorChanged ? { statusChangedAt: now } : {}) },
        });
        result.changed += 1;
        if (colorChanged) {
          await prisma.constructionStatusChange.create({ data: { projectId: prev.id, fromColor: prev.colorStatus, toColor: colorDb, changedAt: now } });
        }
      } else {
        await prisma.constructionProject.update({ where: { id: prev.id }, data: { lastSeenAt: now } });
      }
      if (item.category === "residential" && (hashChanged || !prev.detailFetchedAt)) needPage.push({ sourceId: item.sourceId, projectId: prev.id, url, hash: item.hash });
    }

    // Пропавшие из списка: помечаем, не удаляем (сторож выше уже убедился, что список не обрезан).
    const seen = new Set(parsed.items.map((i) => i.sourceId));
    const goneIds = existing.filter((p) => !seen.has(p.sourceId) && p.removedAt === null).map((p) => p.id);
    if (previousActive >= 20 && goneIds.length > previousActive * MAX_GONE_RATIO) {
      throw new Error(`Из реестра исчезло ${goneIds.length} проектов из ${previousActive} за один забор: сбой источника, ничего не помечено`);
    }
    if (goneIds.length > 0) {
      await prisma.constructionProject.updateMany({ where: { id: { in: goneIds } }, data: { removedAt: now } });
      result.removed = goneIds.length;
    }

    // Страницы объектов: по одной, с паузой. Сбой одной страницы не валит забор: повторится в следующий раз.
    let pageFailures = 0;
    let layoutBad = 0;
    let attempted = 0;
    for (const target of needPage.slice(0, DETAILS_PER_RUN_CAP)) {
      // Сторож вёрстки: если почти все страницы подряд «без узнаваемых данных», реестр сменил разметку. Не долбим сайт зря.
      if (attempted >= LAYOUT_MIN_SAMPLE && layoutBad / attempted > LAYOUT_BAD_RATIO) break;
      attempted += 1;
      try {
        const html = await source.fetchPage(target.url);
        const page: ParsedProjectPage = parseRegistryProjectPage(html);
        // Страница пришла, но ничего не разобралось (заглушка или другая разметка): прежние данные не затираем.
        if (!page.address && !page.description && page.blocks.length === 0 && page.documents.length === 0) {
          layoutBad += 1;
          throw new Error("страница без узнаваемых данных");
        }
        await prisma.constructionProject.update({
          where: { id: target.projectId },
          data: {
            address: page.address,
            description: page.description,
            floors: page.floors,
            blocks: page.blocks,
            documents: page.documents,
            warning: page.warning,
            detailFetchedAt: new Date(),
            listHash: target.hash,
          },
        });
        result.detailsFetched += 1;
      } catch (err) {
        pageFailures += 1;
        if (pageFailures <= 3) void logSystemError("cron", `Реестр строек: страница ${target.sourceId} не прочитана: ${err instanceof Error ? err.message : String(err)}`);
      }
      await source.sleep(PAGE_PAUSE_MS);
    }

    if (attempted >= LAYOUT_MIN_SAMPLE && layoutBad / attempted > LAYOUT_BAD_RATIO) {
      const msg = `Реестр строек: вёрстка страниц memor.pro, похоже, изменилась: ${layoutBad} из ${attempted} страниц без узнаваемых данных. Старые данные сохранены, разбор страниц нужно поправить.`;
      result.error = msg;
      void logSystemError("cron", msg);
    }
    result.linked = await autoLinkAllProperties();
    if (settings.notify) result.notified = await notifyStatusChanges();
    result.ok = true;
    await prisma.constructionSyncRun.update({
      where: { id: run.id },
      data: { ok: true, finishedAt: new Date(), fetched: result.fetched, created: result.created, changed: result.changed, removed: result.removed, detailsFetched: result.detailsFetched, linked: result.linked },
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.error = message;
    if (runIdForCatch) {
      await prisma.constructionSyncRun.update({ where: { id: runIdForCatch }, data: { ok: false, finishedAt: new Date(), error: message.slice(0, 500), fetched: result.fetched } }).catch(() => undefined);
    }
    void logSystemError("cron", `Реестр разрешённых строек: забор не удался: ${message}`);
    return result;
  } finally {
    running = false;
  }
}

/**
 * Уведомление ответственному агенту: у привязанного объекта сменился цвет проекта в реестре.
 * Берём из таблицы ConstructionStatusChange (notifiedAt пусто, цвет «был → стал»), а не из памяти процесса: упавший забор
 * ничего не теряет, повторный не шлёт дважды. Только лента (без пуша); текст как данные реестра. Первый забор и новые проекты
 * записываются уже с notifiedAt и не уведомляют. При выключенном рубильнике уведомлений строки остаются неотправленными.
 */
export async function notifyStatusChanges(): Promise<number> {
  const pending = await prisma.constructionStatusChange.findMany({
    where: { notifiedAt: null, fromColor: { not: null } },
    orderBy: { changedAt: "asc" },
    take: 500,
  });
  let sent = 0;
  for (const c of pending) {
    const links = await prisma.constructionPropertyLink.findMany({
      where: { projectId: c.projectId, state: "LINKED", property: { deletedAt: null } },
      include: {
        project: { select: { customer: true } },
        property: { select: { id: true, shortId: true, intakeAgentId: true, assignedAgentId: true, createdById: true } },
      },
      take: 200,
    });
    const from = COLOR_OUT[c.fromColor!];
    const to = COLOR_OUT[c.toColor];
    for (const link of links) {
      const agentId = propertyOwnerAgentId(link.property);
      if (!agentId || from === to) continue;
      const label = REGISTRY_COLOR_LABEL[to];
      await notifyFeedOnly([agentId], {
        kind: "task",
        title: `Реестр строек: у объекта №${link.property.shortId} теперь «${label.title}»`,
        body: `${link.project.customer}: цвет в реестре изменился с «${REGISTRY_COLOR_LABEL[from].title}» на «${label.title}». ${label.warning ?? "В реестре отмечено, что разрешение есть."}`,
        url: `/properties/${link.property.shortId}`,
        tag: `construction-registry-${link.property.id}-${to}`,
      });
      sent += 1;
    }
    await prisma.constructionStatusChange.update({ where: { id: c.id }, data: { notifiedAt: new Date() } });
  }
  return sent;
}

const COLOR_OUT: Record<"GREEN" | "YELLOW" | "RED", RegistryColor> = { GREEN: "green", YELLOW: "yellow", RED: "red" };
