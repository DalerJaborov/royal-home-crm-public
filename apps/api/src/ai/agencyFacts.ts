import { prisma } from "../db.js";
import { daysOffSentenceRu, isDayOff, normalizeDaysOff, startOfWorkingDayAtOrAfter, type DaysOffCalendar } from "@royal-home/shared";
import {
  dushanbeDateString,
  dushanbeNextOccurrence,
  dushanbeTimeString,
  dushanbeWallClock,
  isWithinDushanbeWindow,
} from "../lib/dushanbeTime.js";
import { SHOWING_HOURS_LAST, SHOWING_HOURS_START } from "../lib/showingBooking.js";
import { vacancyOfficeAddress } from "./vacancyFacts.js";
import { PUBLIC_AGENCY_CONTACT } from "../lib/publicAgencyContact.js";

/**
 * ОДНО ОКНО ИНФОРМАЦИИ ДЛЯ ЧАТ-БОТА И ГОЛОСОВОГО РОБОТА (аудит 10.10.2026,
 * docs/audit-bots-2026-10-10-knowledge.md, раздел «План»).
 *
 * Факты о компании лежат здесь ДАННЫМИ, а тексты для обоих ботов собираются из них
 * функциями этого файла. Копия текста в одном канале расходится с другим молча: оба
 * канала согласны сами с собой, и ни одна проверка не видит, что клиенту в WhatsApp и
 * по телефону говорят разное (тот же класс, что #752 в CLAUDE.md). Сторож —
 * tests/bots-one-window.test.ts: каждый блок отсюда обязан стоять в обоих промтах
 * одним и тем же текстом.
 *
 * Не в packages/shared: фронту эти тексты не нужны, а `audit:rules` ловит двойников
 * между apps/api и apps/web — здесь двойника на сайте нет. Офис — из VACANCY_FACTS
 * (vacancyFacts.ts), не копией.
 *
 * Что здесь:
 *  - AGENCY_FACTS — данные (город, контакты, аренда, рассрочка, ипотека, комиссия);
 *    выходные — НЕ здесь, а в Настройках (Settings.companyDaysOff, владелец 11.10.2026),
 *    они едут в часах (ClientHours.daysOff);
 *  - companyInfoBlock() — блок <company_info> обоим ботам (он же AGENCY_COMPANY_INFO);
 *  - часы для клиентов: CLIENT_HOURS (флаг источника), clientHoursSentence,
 *    agencyHoursBlock (голос), chatHoursBlock (чат);
 *  - обещание звонка агента: callbackPromise() — ОДНО решение «сегодня / завтра /
 *    в понедельник» для чата, голоса и задачи агенту;
 *  - BOT_NAMES_ASSIGNED_AGENT — флаг «называть ли клиенту имя агента».
 * Сверка выученных правил с этими фактами — agencyFactsLessons.ts.
 */

export const AGENCY_FACTS = {
  name: "Royal Home",
  city: "Душанбе",
  /** Только Душанбе: другие города не обслуживаем. */
  otherCities: false,
  phone: PUBLIC_AGENCY_CONTACT.phone,
  site: "royalhome.tj",
  services: "Продажа и помощь в покупке",
  /** АРЕНДЫ СЕЙЧАС НЕТ (ни сдаём, ни снимаем). */
  rent: false,
  /** SALES_FACTS: «РАССРОЧКА И ИПОТЕКА. Их НЕТ. Совсем». Решение владельца P0-2 ждёт:
   *  станет правдой — поменять здесь, и сторож правил перестанет их гасить. */
  installments: false,
  mortgage: false,
  commission: { sellerPercent: 2, buyerPercent: 0 },
  /** Торг ведёт агент с собственником; размер скидки бот не называет никогда. */
  botNamesDiscount: false,
  /** Юр. справка: «всё чисто» не гарантируем — проверяют нотариус и МБТИ. */
  guarantees: false,
} as const;

/**
 * Блок <company_info> — ОДИН текст обоим ботам. Побайтово тот же, что был литералом в
 * leadQualifier.ts (AGENCY_COMPANY_INFO теперь = companyInfoBlock()).
 */
export function companyInfoBlock(): string {
  const f = AGENCY_FACTS;
  return `
<company_info>
Агентство: ${f.name}. Город: ${f.city} (всегда, другие города не обслуживаем).
Офис: ${vacancyOfficeAddress()}. Спросят «где вы находитесь», «как к вам добраться» — назови город, улицу с домом, здание, этаж и ориентиры; приезжать в офис нужно, когда договорились с агентом, показы проходят на самих объектах.
Услуги: ${f.services}.
Аренда: ${f.rent ? "есть" : "АРЕНДЫ СЕЙЧАС НЕТ (ни сдаём, ни снимаем)"}.
Контакты: ${f.phone}, сайт ${f.site}.
Этот номер только для звонков. Не называй его WhatsApp и не предлагай отправлять на него сообщения или файлы. Написать можно в текущем чате или директе; для резюме в Instagram предложи фото страниц или текст, а не несуществующий WhatsApp для файлов.
</company_info>
`;
}

// ── имя агента ────────────────────────────────────────────────────────────────

/**
 * НАЗЫВАТЬ ЛИ КЛИЕНТУ ИМЯ АГЕНТА — ОДИН ФЛАГ (аудит 10.10, P2-10 и real-failures P0-2).
 *
 * Сейчас (по умолчанию, как было): при передаче заявки чат называет того агента, кому
 * заявка УЖЕ ушла (lib/handoffPromise.ts, решение Dan 02.10.2026 «Имя и срок»), голос
 * называет агента клиента и агента объекта. Правило промта чата «НЕ ОБЕЩАЙ ОТ ИМЕНИ
 * КОНКРЕТНОГО ЧЕЛОВЕКА» (leadQualifier.ts) запрещает имя, выдуманное моделью; имя из
 * кода оно не отменяет, но бот-аудит читает это как invented_fact. Решение — за
 * владельцем; поменять значение здесь, и handoffPromise перестанет называть имя.
 * Голосовой промт консультанта (knownClientRule) этим флагом не управляется: там имя
 * нужно для соединения с агентом — это отдельный вопрос владельцу.
 */
export const BOT_NAMES_ASSIGNED_AGENT = true;

// ── часы работы для клиентов ──────────────────────────────────────────────────

export interface ClientHours {
  start: string;
  end: string;
  /**
   * Общие выходные компании (Settings.companyDaysOff, 0 — воскресенье … 6 — суббота).
   * Пусто или нет — выходных нет (владелец 11.10.2026: «у нас нет никаких выходных»).
   */
  daysOff?: readonly number[];
}

/**
 * ИСТОЧНИК ЧАСОВ, КОТОРЫЕ БОТЫ НАЗЫВАЮТ КЛИЕНТУ И ПО КОТОРЫМ ОБЕЩАЮТ ЗВОНОК (P1-2).
 *
 * "leadWindow" (по умолчанию, как голос до этой правки) — окно раздачи лидов
 * Settings.workHoursStart/End (lib/workingHours.ts). По своему описанию это окно
 * раздачи, а не часы офиса, но отдельной настройки часов офиса в базе нет. Владелец
 * решит иначе — сюда ставится фиксированное окно `{ start, end }` (без миграции), а
 * когда появится поле в Настройках — его чтение в loadClientHours. Одно место.
 */
export type ClientHoursSource = "leadWindow" | ClientHours;
export const CLIENT_HOURS: ClientHoursSource = "leadWindow";

/** Запасное окно, если Настройки не прочитались — то же, что у isWithinWorkingHours. */
export const DEFAULT_CLIENT_HOURS: ClientHours = { start: "09:30", end: "18:00" };

/** Часы для клиентов из прочитанных Настроек по флагу CLIENT_HOURS. null — нет данных. */
export function resolveClientHours(
  settings: { workHoursStart: string; workHoursEnd: string; companyDaysOff?: readonly number[] | null } | null | undefined,
  source: ClientHoursSource = CLIENT_HOURS
): ClientHours | null {
  const daysOff = normalizeDaysOff(settings?.companyDaysOff);
  if (source !== "leadWindow") return { ...source, daysOff };
  return settings ? { start: settings.workHoursStart, end: settings.workHoursEnd, daysOff } : null;
}

/** Прочитать часы. null — Настройки не прочитались (честное «нет данных» в промте). */
export async function loadClientHours(): Promise<ClientHours | null> {
  const settings = await prisma.settings
    .findUnique({ where: { id: "singleton" }, select: { workHoursStart: true, workHoursEnd: true, companyDaysOff: true } })
    .catch(() => null);
  return resolveClientHours(settings);
}

/**
 * Фраза о часах — один текст в обоих промтах. Выходные — из Настроек (11.10.2026):
 * пусто — «выходных нет — работаем каждый день», иначе называем дни.
 */
export function clientHoursSentence(hours: ClientHours | null | undefined): string {
  return hours
    ? `Агенты на связи с ${hours.start} до ${hours.end} по Душанбе; ${daysOffSentenceRu(hours.daysOff)}.`
    : "Точных часов работы сейчас нет — на вопрос о часах скажи, что агент наберёт в рабочее время.";
}

/** Календарь выходных из часов компании и (если известен) личных выходных агента. */
export function hoursCalendar(hours: ClientHours | null | undefined, agentDaysOff?: readonly number[] | null): DaysOffCalendar {
  return { companyDaysOff: hours?.daysOff ?? [], agentDaysOff: agentDaysOff ?? [] };
}

/**
 * ЧАСЫ И ОФИС ДЛЯ ГОЛОСА (09.10.2026, перенесено сюда 10.10 из liveVoiceKnowledge.ts без
 * изменения текста). Окно показов — константы записи на показ (showingBooking.ts).
 */
export function agencyHoursBlock(workHours: ClientHours | null | undefined): string {
  return `

<часы_и_офис>
${clientHoursSentence(workHours)} Показы — с ${SHOWING_HOURS_START} до ${SHOWING_HOURS_LAST}${workHours?.daysOff?.length ? " в рабочие дни" : " каждый день"}; у агента бывает свой выходной — свободное время показа и перезвона называют инструменты. Часы называй словами («с половины десятого до шести»).
ОФИС: ${vacancyOfficeAddress()}. Спросят «где ваш офис», «как к вам добраться» — назови город, улицу с домом, здание, этаж и ориентиры. Адрес не придумывай и не меняй. В офис приезжают, когда договорились с агентом; показ проходит на самом объекте.
</часы_и_офис>`;
}

/**
 * ЧАСЫ ДЛЯ ЧАТА (P1-2: на «до скольки работаете» чату раньше отвечать было нечем).
 * Та же фраза, что у голоса; офис чат уже знает из <company_info>, второй раз не нужен.
 */
export function chatHoursBlock(hours: ClientHours | null | undefined): string {
  return `\n\nЧАСЫ РАБОТЫ: ${clientHoursSentence(hours)} Спросят «до скольки работаете» или «когда позвонят» — отвечай по этой строке, другие часы не придумывай.`;
}

/** Рабочее время для клиента: окно часов и не выходной (общий из часов и — если передан —
 *  личный агента). Одно правило для чата, голоса (consultantHours.ts) и задачи «перезвонить». */
export function isClientWorkingTime(
  at: Date,
  hours: ClientHours | null | undefined,
  agentDaysOff?: readonly number[] | null
): boolean {
  if (isDayOff(at, hoursCalendar(hours, agentDaysOff))) return false;
  const h = hours ?? DEFAULT_CLIENT_HOURS;
  return isWithinDushanbeWindow(h.start, h.end, at);
}

// ── обещание звонка агента ────────────────────────────────────────────────────

/** Меньше этого до конца окна — «сегодня» уже не обещаем (правило handoffPromise 02.10). */
export const TODAY_PROMISE_MIN_LEFT_MIN = 60;

export type CallbackPromiseKind = "today" | "laterToday" | "tomorrow" | "weekday";

export interface CallbackPromise {
  kind: CallbackPromiseKind;
  /** Что сказать клиенту: «сегодня», «завтра после 10:00», «в понедельник после 10:00». */
  ru: string;
  tg: string;
  /** С какого момента агент может звонить: сейчас (today) или начало рабочего окна. */
  startsAt: Date;
  /** Звонок отложен до начала следующего окна (ночью/в выходной) — без ночных пушей. */
  deferred: boolean;
}

const WEEKDAY_RU = ["в воскресенье", "в понедельник", "во вторник", "в среду", "в четверг", "в пятницу", "в субботу"];
const WEEKDAY_TG = ["рӯзи якшанбе", "рӯзи душанбе", "рӯзи сешанбе", "рӯзи чоршанбе", "рӯзи панҷшанбе", "рӯзи ҷумъа", "рӯзи шанбе"];

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * КОГДА ПОЗВОНИТ АГЕНТ — ОДНО РЕШЕНИЕ НА ЧАТ И ГОЛОС (P1-1).
 *
 * Раньше: чат в рабочее окно обещал «ПРЯМО СЕЙЧАС, в ближайшие минуты» и воскресенья не
 * различал (callbackRequest.ts), передача заявки — «сегодня в течение часа»
 * (handoffPromise.ts), голос — «сегодня, минуты не называй», ночью «утром» (в субботу
 * вечером это вело на воскресенье). Один клиент в воскресенье в 15:00 слышал в WhatsApp
 * «позвонят сейчас», а по телефону — «утром».
 *
 * Теперь:
 *  - рабочий день, внутри окна и до конца больше часа — «сегодня» (минуты не называем:
 *    по данным 10.10 «в течение часа» выдерживалось в половине случаев);
 *  - рабочий день до начала окна — «сегодня после ЧЧ:ММ»;
 *  - иначе ближайший рабочий день: «завтра после ЧЧ:ММ» или «в понедельник после ЧЧ:ММ».
 * Рабочий день — по Настройкам (11.10.2026): общие выходные из `hours.daysOff`, а если
 * известен агент, который будет звонить, — и его личные (`agentDaysOff`). Пусто —
 * выходных нет: в воскресенье вечером обещаем «завтра», а не «в понедельник» по привычке.
 * «Прямо сейчас» не обещает никто: из переписки автодозвона нет (с 22.09 просьба идёт
 * агенту пушем, callbackRequest.ts), а живое соединение у голоса — transfer_to_agent.
 * Срок задачи агенту (consultantCallbackTarget.ts::callbackDueAt) берётся отсюда же.
 */
export function callbackPromise(
  at: Date,
  hours: ClientHours | null | undefined,
  agentDaysOff?: readonly number[] | null
): CallbackPromise {
  const { start, end } = hours ?? DEFAULT_CLIENT_HOURS;
  const cal = hoursCalendar(hours, agentDaysOff);
  const dayOff = isDayOff(at, cal);
  const sameDayWindow = start <= end;
  if (!dayOff && isWithinDushanbeWindow(start, end, at)) {
    const left = minutesOf(end) - minutesOf(dushanbeTimeString(at));
    if (!sameDayWindow || left >= TODAY_PROMISE_MIN_LEFT_MIN) {
      return { kind: "today", ru: "сегодня", tg: "имрӯз", startsAt: at, deferred: false };
    }
  }
  // Ближайшее начало окна строго после «сейчас» в рабочий день (выходные пропускаются).
  const startsAt = startOfWorkingDayAtOrAfter(dushanbeNextOccurrence(start, at), cal, start);
  const today = dushanbeDateString(at);
  const tomorrow = dushanbeDateString(new Date(at.getTime() + 24 * 3600_000));
  const day = dushanbeDateString(startsAt);
  if (day === today) {
    return { kind: "laterToday", ru: `сегодня после ${start}`, tg: `имрӯз баъд аз соати ${start}`, startsAt, deferred: true };
  }
  if (day === tomorrow) {
    return { kind: "tomorrow", ru: `завтра после ${start}`, tg: `пагоҳ баъд аз соати ${start}`, startsAt, deferred: true };
  }
  const weekday = dushanbeWallClock(startsAt).getUTCDay();
  return {
    kind: "weekday",
    ru: `${WEEKDAY_RU[weekday]} после ${start}`,
    tg: `${WEEKDAY_TG[weekday]} баъд аз соати ${start}`,
    startsAt,
    deferred: true,
  };
}

/** Одна строка «когда позвонит агент» для промта — одинаковая в чате и голосе. */
export function callbackPromiseLine(p: CallbackPromise): string {
  return `КОГДА ПОЗВОНИТ АГЕНТ: ${p.ru} (по-таджикски «${p.tg}»). Другого срока не называй, «прямо сейчас» и минуты не обещай.`;
}
