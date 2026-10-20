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
  /** Однозначно и доступен: клиент закрепляется за ним мимо очереди. */
  | { status: "matched"; agentId: string; fullName: string; namedAs: string }
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

/** Слово похоже на часть имени сотрудника. */
function looksLikeName(word: string, part: string): boolean {
  if (word === part) return true;
  const a = nameStem(word);
  const b = nameStem(part);
  if (a.length < MIN_NAME_LENGTH || b.length < MIN_NAME_LENGTH) return false;
  if (a === b) return true;
  const max = tolerance(Math.min(a.length, b.length));
  if (max === 0) return false;
  return levenshteinDistance(a, b, max) <= max;
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
  const { now = new Date(), requireCue = true } = options;
  const parsed = requestTextSchema.safeParse(text);
  if (!parsed.success) return { status: "none" };
  const raw = parsed.data;
  if (requireCue && !REQUEST_CUES.test(raw)) return { status: "none" };

  const cleaned = normalize(raw.replace(SELF_INTRO, " "));
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { status: "none" };
  const digits = new Set(words.filter((w) => /^\d{3,5}$/.test(w)));

  // Сколько частей имени сотрудника прозвучало: «Баходур Рахимов» даст 2 и разведёт
  // тёзок сам, без переспрашивания.
  const hits = new Map<string, { agent: KnownAgent; parts: number; namedAs: string }>();
  for (const agent of agents) {
    const parts = nameParts(agent.fullName);
    if (parts.length === 0) continue;
    let matched = 0;
    let namedAs = "";
    for (const part of parts) {
      const word = words.find((w) => looksLikeName(w, part));
      if (word) {
        matched++;
        if (!namedAs) namedAs = word;
      }
    }
    if (matched > 0) hits.set(agent.id, { agent, parts: matched, namedAs });
  }
  if (hits.size === 0) return { status: "none" };

  let candidates = [...hits.values()];
  // Внутренний номер сотрудника, названный рядом с именем, — прямое уточнение.
  const byExtension = candidates.filter((c) => c.agent.sipExtension && digits.has(c.agent.sipExtension));
  if (byExtension.length === 1) candidates = byExtension;
  else {
    // Названы имя И фамилия — этого достаточно, чтобы отсеять тёзку по имени.
    const best = Math.max(...candidates.map((c) => c.parts));
    candidates = candidates.filter((c) => c.parts === best);
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
  return { status: "matched", agentId: only.agent.id, fullName: only.agent.fullName.trim(), namedAs: only.namedAs };
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
      return `Клиент сам назвал сотрудника: ${match.fullName} — закреплён за ним вне очереди`;
    case "ambiguous":
      return `Клиент назвал имя «${match.namedAs}», но однозначно определить не вышло — подходят: ${match.candidates
        .map((c) => c.fullName)
        .join(", ")}. Лид распределён обычным порядком`;
    case "unavailable":
      return `Клиент просил ${match.fullName}, но тот ${blockWording(match.reason)} — лид распределён обычным порядком`;
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
