import { z } from "zod";
import { prisma } from "../db.js";
import type { ClientLanguage } from "../ai/clientLanguage.js";
import { levenshteinDistance } from "./levenshtein.js";
import { SALES_AGENT_ROLES } from "@royal-home/shared";

/**
 * «МНЕ НУЖЕН УМЕД» — КЛИЕНТ САМ НАЗВАЛ, К КОМУ ХОЧЕТ (решение владельца 18.08.2026).
 *
 * Человек говорит «я работаю с Нозой», «мне посоветовали Баходура», «передайте
 * Умеду» — и это самый крепкий сигнал, какой у нас вообще бывает. Крепче совпадения
 * по номеру телефона и несравнимо крепче нашего сопоставления по смыслу разговора:
 * там мы ДОГАДЫВАЕМСЯ, кому клиент причитается, а здесь он говорит это вслух.
 * Поэтому такой клиент закрепляется за названным сотрудником мимо очереди по KPI.
 *
 * ПОЧЕМУ РАСПОЗНАЁТ КОД, А НЕ МОДЕЛЬ. В чате ответ нужен мгновенно, прямо в
 * разговоре, и лишний вызов ИИ на каждом ходе — это и деньги, и секунды. Но главное
 * не в этом: модель спокойно вернёт имя, которого у нас нет вовсе, или «Баходур»
 * там, где Баходуров двое. Промт — просьба, а не гарантия, поэтому РЕШЕНИЕ (кого
 * именно выбрали и что делать при тёзках) принимается здесь, по списку сотрудников
 * из базы. Модель в звонке (ai/incomingCallLead.ts) всего лишь ПОДСКАЗЫВАЕТ строку
 * «названное имя» — сверяет её с базой всё равно этот модуль.
 *
 * КАК ПЕРЕЖИВАЕМ СКЛОНЕНИЯ И ОПЕЧАТКИ, НЕ ПЛАТЯ ЗА ИИ. Русское склонение меняет
 * ХВОСТ слова, а не начало: «Умеду», «с Нозой», «Баходуру», «Абубакром». Поэтому
 * слово и имя сотрудника приводятся к основе (снимается падежное окончание), а
 * дальше сравниваются с допуском по расстоянию Дамерау—Левенштейна — он и закрывает
 * опечатки («Бахадур», «Ноаз»). Допуск растёт с длиной имени: у короткого имени одна
 * ошибка — это уже другое имя.
 *
 * ПОЧЕМУ ОБЯЗАТЕЛЕН ПОВОД (`REQUEST_CUES`). Без него «Ноза» в любой реплике
 * («меня зовут Ноза») уводила бы чужого клиента к сотруднице с тем же именем. Имя
 * ищется, только когда в сообщении есть просьба о человеке: «нужен», «работаю с»,
 * «посоветовали», «соедините», таджикское «даркор». Это главный предохранитель от
 * ложных срабатываний, и он же — причина, по которой мы иногда просьбу пропустим
 * (человек написал одно слово «Умед»). Пропустить сигнал безопаснее, чем увести
 * клиента у агента, которому он достался по очереди.
 */

/** Сотрудник в том виде, в каком он нужен распознаванию. */
export interface KnownAgent {
  id: string;
  fullName: string;
  role: string;
  isActive: boolean;
  frozenAt: Date | null;
  leadsPausedUntil: Date | null;
  /** Внутренний номер — им клиент может развести тёзок («Баходур, 1012»). */
  sipExtension: string | null;
}

/** Почему названный сотрудник не может взять клиента прямо сейчас. */
export type RequestedAgentBlock = "fired" | "frozen" | "paused" | "not_agent";

export type RequestedAgentMatch =
  /** Имени сотрудника в сообщении нет — обычный путь, ничего не выдумываем. */
  | { status: "none" }
  /**
   * Однозначно и доступен: клиент закрепляется за ним мимо очереди.
   * `resolvedBy` (26.11.2026) — чем развели похожих, если имя подошло нескольким:
   * "property" — один из них хозяин узнанного объекта; "active" — остальные
   * уволены, а имя расслышано с ошибкой. Нет поля — имя подошло одному.
   */
  | { status: "matched"; agentId: string; fullName: string; namedAs: string; resolvedBy?: "property" | "similar_property" | "active" }
  /** Имя подошло двоим и больше — НЕ УГАДЫВАЕМ (в базе два Баходура). */
  | { status: "ambiguous"; namedAs: string; candidates: { id: string; fullName: string }[] }
  /** Нашли одного, но он сейчас не берёт клиентов (уволен, заморожен, на паузе). */
  | { status: "unavailable"; agentId: string; fullName: string; namedAs: string; reason: RequestedAgentBlock };

/**
 * Повод искать в сообщении имя сотрудника. Русский и таджикский вперемешку —
 * ровно так люди и пишут («ба ман Умед даркор»).
 */
const REQUEST_CUES =
  /(нужен|нужна|нужны|нуже|хочу|хотел|хотела|работа(ю|л|ла) с|веду с|вед[её]т|посовет|порекоменд|соедин|свяжите|переда(й|йте|ть)|позов|позвать|можно ли|дайте|дай|обраща(лся|лась)|агент|риелтор|риэлтор|менеджер|сотрудник|даркор|лозим|мехоҳам|мехохам|мехостам|гуфт|бо )/i;

/**
 * Человек представляется САМ — и это не просьба о сотруднике. «Меня зовут Ноза»
 * не должно уводить клиентку к агенту Нозе. Кусок после такой связки выбрасывается
 * из поиска целиком (три слова — с запасом на имя, отчество и фамилию).
 */
const SELF_INTRO = /(меня зовут|моё имя|мое имя|я —|я -|номи ман|ман ном|нomi man|manam)\s+(\S+\s*){0,3}/gi;

/** Падежные окончания, которые снимаются с имени перед сравнением. Порядок важен:
 *  длинные раньше коротких, иначе «Абубакром» превратится в «Абубакро». */
const CASE_ENDINGS = ["ами", "ями", "ому", "ему", "ой", "ей", "ом", "ем", "ым", "им", "ах", "ях", "ов", "ев", "у", "ю", "а", "я", "ы", "и", "е", "ь", "й"];

/** Слова короче — не имена, а предлоги и мусор («с», «к», «до»). */
const MIN_NAME_LENGTH = 3;

/** Кэш списка сотрудников. Держим коротко: новый сотрудник обязан заработать без
 *  перезапуска контейнера, а список читается на КАЖДОМ ходе бота. */
const AGENTS_CACHE_MS = 60_000;
/** Потолок выборки: у любого запроса, возвращающего массив, есть предел. */
const AGENTS_LIMIT = 500;

let cache: { at: number; agents: KnownAgent[] } | null = null;

/** Текст с внешней границы (реплика клиента, ответ модели). Обрезаем: искать имя
 *  в пересланной простыне на 50 КБ незачем, просьба звучит в начале. */
const requestTextSchema = z.string().trim().min(1).max(4000);

/** Сбросить кэш (тесты и место, где сотрудника только что завели/выключили). */
export function resetKnownAgentsCache(): void {
  cache = null;
}

/**
 * Сотрудники для распознавания. Берутся ВСЕ, а не только активные: уволенного
 * тоже надо УЗНАТЬ — иначе «мне нужен Умед», уволенный месяц назад, выглядел бы
 * как «такого имени у нас нет», и клиент получил бы вежливое молчание вместо
 * честного «этот сотрудник у нас больше не работает».
 */
export async function loadKnownAgents(): Promise<KnownAgent[]> {
  if (cache && Date.now() - cache.at < AGENTS_CACHE_MS) return cache.agents;
  const rows = await prisma.agent.findMany({
    select: {
      id: true,
      fullName: true,
      role: true,
      isActive: true,
      frozenAt: true,
      leadsPausedUntil: true,
      sipExtension: true,
    },
    orderBy: { fullName: "asc" },
    take: AGENTS_LIMIT,
  });
  cache = { at: Date.now(), agents: rows };
  return rows;
}

/** Приводим к сравнимому виду: нижний регистр, ё→е, латиница остаётся как есть. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/ё/g, "е").replace(/[^0-9a-zа-яҳқғӯҷӣ\s]/gi, " ");
}

/** Основа имени без падежного окончания: «умеду»→«умед», «нозой»→«ноз». */
export function nameStem(word: string): string {
  let w = word;
  for (const ending of CASE_ENDINGS) {
    if (w.length - ending.length >= MIN_NAME_LENGTH && w.endsWith(ending)) {
      w = w.slice(0, -ending.length);
      break;
    }
  }
  return w;
}

/** Сколько ошибок прощаем в основе. Короткому имени — ни одной: «Умед» и «Ахмед»
 *  различаются двумя буквами, и списать это на опечатку значит отдать клиента не тому. */
function tolerance(len: number): number {
  if (len <= 4) return 0;
  if (len <= 7) return 1;
  return 2;
}

/**
 * Насколько слово похоже на часть имени сотрудника: 0 — совпало (с точностью до
 * падежа), 1–2 — столько букв расслышано иначе, null — не это имя. Расстояние
 * нужно, чтобы развести похожих: «Файзуллоев» с расшифровки подходит и
 * «Сайфуллоеву» (2 буквы), и «Нарзуллоеву» (2 буквы); точное совпадение одного из
 * них перебило бы оба (26.11.2026).
 */
function nameDistance(word: string, part: string): number | null {
  if (word === part) return 0;
  const a = nameStem(word);
  const b = nameStem(part);
  if (a.length < MIN_NAME_LENGTH || b.length < MIN_NAME_LENGTH) return null;
  if (a === b) return 0;
  const max = tolerance(Math.min(a.length, b.length));
  if (max === 0) return null;
  const d = levenshteinDistance(a, b, max);
  return d <= max ? d : null;
}

/** Слово похоже на часть имени сотрудника. */
function looksLikeName(word: string, part: string): boolean {
  return nameDistance(word, part) !== null;
}

function nameParts(fullName: string): string[] {
  return normalize(fullName)
    .split(/\s+/)
    .map((p) => p.trim())
    .filter((p) => p.length >= MIN_NAME_LENGTH);
}

function blockOf(agent: KnownAgent, now: Date): RequestedAgentBlock | null {
  if (!agent.isActive) return "fired";
  if (agent.frozenAt) return "frozen";
  if (agent.leadsPausedUntil && agent.leadsPausedUntil.getTime() > now.getTime()) return "paused";
  // Лиды по имени получают агенты и руководитель продаж (HEAD_OF_SALES). Директор — тоже сотрудник и тоже бывает
  // назван по имени, но выдать ему лид очередь не может, и подменять это молча
  // нельзя: клиенту честно говорим, что соединим со свободным.
  if (!(SALES_AGENT_ROLES as readonly string[]).includes(agent.role)) return "not_agent";
  return null;
}

export interface MatchOptions {
  now?: Date;
  /**
   * Требовать повод («нужен», «работаю с», «даркор») — так работает ЧАТ, где на
   * вход идёт сырая реплика человека и любое имя в ней может оказаться его
   * собственным.
   *
   * В ЗВОНКЕ повод не нужен и мешает: туда приходит не реплика, а уже вынутое
   * моделью поле «названный сотрудник» (ai/incomingCallLead.ts) — то есть о
   * намерении сказано отдельно, а в строке стоит одно имя.
   */
  requireCue?: boolean;
  /**
   * СОТРУДНИКИ, СВЯЗАННЫЕ С УЗНАННЫМ ОБЪЕКТОМ (26.11.2026, ПК-001086). Клиент
   * прочитал фамилию с ролика и назвал её с ошибкой («Файзуллоев» вместо
   * «Сайфуллоев»); имя подошло двоим. Если ровно один из похожих — хозяин
   * объекта, о котором шла речь, это не неоднозначность, а подтверждение: его и
   * берём. Пусто — прежнее правило «тёзок не угадываем».
   */
  preferAgentIds?: readonly string[];
  /**
   * ИМЯ ИЗ РАСШИФРОВКИ, А НЕ ИЗ РУК ЧЕЛОВЕКА (26.11.2026): точно расслышанное имя
   * побеждает похожее; среди похожих с ошибкой уволенные уступают действующему.
   * Включает только разбор звонка при рубильнике callObjectToOwnerEnabled; чат
   * (человек пишет сам) — прежнее правило «тёзок не угадываем».
   */
  asrAware?: boolean;
  /**
   * preferAgentIds — хозяин УЗНАННОГО объекта (true) или лишь хозяева похожих
   * (false): от этого зависит подпись в хронологии (ревью 26.11 — слабого
   * кандидата не называть «объектом из разговора»).
   */
  preferIsSure?: boolean;
}

/**
 * Кого назвал клиент. Чистая функция: список сотрудников передаётся снаружи, чтобы
 * её можно было прогнать тестами без базы и без ИИ.
 */
export function matchRequestedAgent(
  text: string,
  agents: KnownAgent[],
  options: MatchOptions = {}
): RequestedAgentMatch {
  const { now = new Date(), requireCue = true, preferAgentIds = [], asrAware = false, preferIsSure = true } = options;
  const parsed = requestTextSchema.safeParse(text);
  if (!parsed.success) return { status: "none" };
  const raw = parsed.data;
  if (requireCue && !REQUEST_CUES.test(raw)) return { status: "none" };

  const cleaned = normalize(raw.replace(SELF_INTRO, " "));
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { status: "none" };
  const digits = new Set(words.filter((w) => /^\d{3,5}$/.test(w)));

  // Сколько частей имени сотрудника прозвучало: «Баходур Рахимов» даст 2 и разведёт
  // тёзок сам, без переспрашивания. `distance` — сколько букв расслышано иначе
  // (сумма по частям): точное имя побеждает похожее.
  const hits = new Map<string, { agent: KnownAgent; parts: number; namedAs: string; distance: number }>();
  for (const agent of agents) {
    const parts = nameParts(agent.fullName);
    if (parts.length === 0) continue;
    let matched = 0;
    let namedAs = "";
    let distance = 0;
    for (const part of parts) {
      let bestWord: string | null = null;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const w of words) {
        const d = nameDistance(w, part);
        if (d !== null && d < bestDistance) {
          bestDistance = d;
          bestWord = w;
        }
      }
      if (bestWord) {
        matched++;
        distance += bestDistance;
        if (!namedAs) namedAs = bestWord;
      }
    }
    if (matched > 0) hits.set(agent.id, { agent, parts: matched, namedAs, distance });
  }
  if (hits.size === 0) return { status: "none" };

  let candidates = [...hits.values()];
  let resolvedBy: "property" | "similar_property" | "active" | undefined;
  // Внутренний номер сотрудника, названный рядом с именем, — прямое уточнение.
  const byExtension = candidates.filter((c) => c.agent.sipExtension && digits.has(c.agent.sipExtension));
  if (byExtension.length === 1) candidates = byExtension;
  else {
    // Названы имя И фамилия — этого достаточно, чтобы отсеять тёзку по имени.
    const best = Math.max(...candidates.map((c) => c.parts));
    candidates = candidates.filter((c) => c.parts === best);
  }
  if (asrAware && candidates.length > 1) {
    // Имя расслышано точно у одного и с ошибками у других — точное побеждает.
    const closest = Math.min(...candidates.map((c) => c.distance));
    candidates = candidates.filter((c) => c.distance === closest);
  }
  if (candidates.length > 1 && preferAgentIds.length > 0) {
    // Ровно один из похожих связан с объектом разговора — это подтверждение, не тёзки.
    const byProperty = candidates.filter((c) => preferAgentIds.includes(c.agent.id));
    if (byProperty.length === 1) {
      candidates = byProperty;
      resolvedBy = preferIsSure ? "property" : "similar_property";
    }
  }
  if (asrAware && candidates.length > 1 && candidates.every((c) => c.distance > 0)) {
    /**
     * ИМЯ РАССЛЫШАНО С ОШИБКОЙ, И СРЕДИ ПОХОЖИХ ЕСТЬ УВОЛЕННЫЕ (26.11.2026).
     * «Файзуллоев» подошёл и действующему Сайфуллоеву, и давно уволенному
     * Нарзуллоеву — звать это тёзками и отдавать заявку по очереди значит
     * отнять клиента у того, кто один и мог иметься в виду. Правило «уволенного
     * тоже надо узнать» остаётся для имени, названного ТОЧНО (distance 0).
     */
    const working = candidates.filter((c) => c.agent.isActive);
    if (working.length === 1 && working.length < candidates.length) {
      candidates = working;
      resolvedBy = "active";
    }
  }

  if (candidates.length > 1) {
    return {
      status: "ambiguous",
      namedAs: candidates[0].namedAs,
      candidates: candidates.map((c) => ({ id: c.agent.id, fullName: c.agent.fullName.trim() })),
    };
  }

  const only = candidates[0];
  const block = blockOf(only.agent, now);
  if (block) {
    return {
      status: "unavailable",
      agentId: only.agent.id,
      fullName: only.agent.fullName.trim(),
      namedAs: only.namedAs,
      reason: block,
    };
  }
  return {
    status: "matched",
    agentId: only.agent.id,
    fullName: only.agent.fullName.trim(),
    namedAs: only.namedAs,
    ...(resolvedBy ? { resolvedBy } : {}),
  };
}

/** То же по тексту с внешней границы, со списком сотрудников из базы. */
export async function detectRequestedAgent(
  text: string | null | undefined,
  options: MatchOptions = {}
): Promise<RequestedAgentMatch> {
  if (!text) return { status: "none" };
  return matchRequestedAgent(text, await loadKnownAgents(), options);
}

/**
 * Ещё раз проверяем сотрудника ПЕРЕД самим назначением.
 *
 * Между репликой клиента и созданием лида проходит от минуты до суток: за это
 * время агента могли уволить, заморозить или он сам выключил приём лидов. Кэш
 * списка здесь не годится вовсе — читаем базу. `null` означает «нельзя, отдавай
 * в обычную очередь».
 */
export async function requestedAgentStillAvailable(agentId: string | null | undefined): Promise<string | null> {
  if (!agentId) return null;
  const agent = await prisma.agent.findUnique({
    where: { id: agentId },
    select: { id: true, fullName: true, role: true, isActive: true, frozenAt: true, leadsPausedUntil: true, sipExtension: true },
  });
  if (!agent) return null;
  return blockOf(agent, new Date()) === null ? agent.id : null;
}

/** Почему сотрудник недоступен — словами, для клиента и для заметки. */
function blockWording(reason: RequestedAgentBlock): string {
  switch (reason) {
    case "fired":
      return "больше у нас не работает";
    case "frozen":
      return "сейчас не работает с клиентами";
    case "paused":
      return "сейчас не принимает новых клиентов";
    case "not_agent":
      return "не ведёт клиентов напрямую";
  }
}

/**
 * ПОМЕТКА В КАРТОЧКУ — обязательна во всех случаях, кроме «имени не было».
 *
 * Даже когда однозначно определить не вышло, факт «человек называл имя» терять
 * нельзя: агент, которому лид достался по очереди, должен это видеть, иначе он
 * узнает о нём от самого клиента («я же просил Баходура») и будет выглядеть глупо.
 */
export function requestedAgentNote(match: RequestedAgentMatch): string | null {
  switch (match.status) {
    case "none":
      return null;
    case "matched":
      return match.resolvedBy === "property"
        ? `Клиент назвал «${match.namedAs}» — это ${match.fullName}, агент объекта из разговора; закреплён за ним вне очереди`
        : match.resolvedBy === "similar_property"
          ? `Клиент назвал «${match.namedAs}» — похоже на ${match.fullName}, агента похожего объекта из разговора; закреплён за ним вне очереди`
          : match.resolvedBy === "active"
          ? `Клиент назвал «${match.namedAs}» — похоже на ${match.fullName} (остальные похожие уже не работают); закреплён за ним вне очереди`
          : `Клиент сам назвал сотрудника: ${match.fullName} — закреплён за ним вне очереди`;
    case "ambiguous":
      return `Клиент назвал имя «${match.namedAs}», но однозначно определить не вышло — подходят: ${match.candidates
        .map((c) => c.fullName)
        .join(", ")}. Заявка распределена обычным порядком`;
    case "unavailable":
      return `Клиент просил ${match.fullName}, но тот ${blockWording(match.reason)} — заявка распределена обычным порядком`;
  }
}

/**
 * Что бот скажет клиенту прямо в разговоре. Возвращается ГОТОВОЙ строкой, а не
 * просьбой к модели: при тёзках переспросить обязан код (промт — не гарантия),
 * иначе модель однажды «уточнит» сама и отдаст клиента наугад.
 */
export function requestedAgentNotice(match: RequestedAgentMatch, language: ClientLanguage): string | null {
  const tj = language === "tg";
  switch (match.status) {
    case "none":
      return null;
    case "matched":
      return tj
        ? `${match.fullName}? Хуб, дархости шуморо ба ӯ мефиристам.`
        : `${match.fullName}? Хорошо, передаю ему.`;
    case "ambiguous": {
      const names = match.candidates.map((c) => c.fullName).join(", ");
      return tj
        ? `Дар мо якчанд корманд бо ин ном ҳастанд (${names}). Насаб ё рақами дохилиашро гуфта метавонед?`
        : `У нас несколько сотрудников с таким именем (${names}). Уточните, пожалуйста, фамилию или добавочный номер.`;
    }
    case "unavailable":
      return tj
        ? `${match.fullName} ҳозир мизоҷони нав қабул карда наметавонад — дархости шуморо ба корманди озод мефиристам.`
        : `${match.fullName} сейчас не может взять нового клиента — передам вашу заявку свободному сотруднику.`;
  }
}

/**
 * Ответ про названного сотрудника не теряется, что бы ни ответила модель.
 *
 * Тот же приём, что у `ensurePhoneAskKept` в ai/leadQualifier.ts: модель просят
 * сказать это своими словами, а код проверяет, что сказано, и дописывает сам.
 * Признак «сказано» — имя сотрудника в ответе: выдумать его модель не могла.
 */
export function ensureRequestedAgentNoticeKept(
  bubbles: string[],
  match: RequestedAgentMatch,
  notice: string | null
): string[] {
  if (!notice || match.status === "none") return bubbles;
  const said = bubbles.join(" ").toLowerCase();
  const stem = nameStem(normalize(match.namedAs));
  if (stem.length >= MIN_NAME_LENGTH && said.includes(stem)) return bubbles;
  return [...bubbles, notice];
}
