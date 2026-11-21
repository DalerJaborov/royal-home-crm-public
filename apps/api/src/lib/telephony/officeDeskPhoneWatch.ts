// СТОРОЖ «ОФИСНЫЙ АППАРАТ НЕ НА СВЯЗИ В РАБОЧЕЕ ВРЕМЯ» (18.11.2026).
//
// Решение владельца: незнакомые звонки — и с линии, и из WhatsApp — идут ТОЛЬКО на
// офисный аппарат (Settings.incomingPrimaryTarget = "extension",
// incomingPrimaryExtension = "2020"; на станции — AstDB ROYALHOME/office_first/ext).
// 18.11 этот аппарат не зарегистрировался на станции за весь день, и никто не
// заметил: звонки шли в пустоту, а все проверки телефонии были зелёными — связь
// со станцией есть, очередь жива, просто нужный аппарат выключен.
//
// ЧТО ДЕЛАЕТ (вызывается из stationHealth.ts::runStationHealthTick, раз в 15 минут):
//  - приём идёт не на аппарат (очередь) — молчит и гасит прошлую тревогу;
//  - аппарат не online на станции (GET /ari/endpoints, тот же признак, что у
//    agentDeviceOnline) в рабочее время компании (Settings.workHoursStart/End по
//    Душанбе, без общих выходных Settings.companyDaysOff) две проверки подряд —
//    тревога в «Здоровье системы»; одна открытая запись на поломку. Первые 45 минут
//    рабочего дня не судим: аппарат утром включают не в первую минуту;
//  - аппарат снова на связи — запись закрывается сама;
//  - ночью и в выходной — не судит (аппарат вправе быть выключен), счётчик сброшен;
//  - у аппарата есть мобильное плечо владельца — не судит: звонок дойдёт до человека;
//  - ЕДИНСТВЕННЫЙ хозяин тревоги «аппарат приёма выключен» (с 18.11.2026): он же раз в
//    сутки зовёт директора; agentMobileFallback.ts про выключенный аппарат молчит и
//    тревожит только про аппарат, которого на станции нет вовсе;
//  - станция не ответила — не судит: обрыв связи со станцией ловит своя сводная
//    тревога (stationHealth.ts, «нет связи со станцией»), вторая про то же не нужна.
import { isDayOff } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { isWithinDushanbeWindow, dushanbeTimeString } from "../dushanbeTime.js";
import { logSystemError } from "../systemError.js";
import { agentDeviceOnline, listEndpointsRetrying, loadAriCredentials, type AriEndpoint } from "./ariClient.js";
import {
  PRIMARY_UNREACHABLE_CALL_PATH,
  incomingPrimaryExtension,
  incomingPrimaryHasMobileLeg,
  notifyDirectorsAboutUnreachablePrimary,
} from "./agentMobileFallback.js";

export const OFFICE_DESK_OFFLINE_ALARM_KEY = "telephony-office-desk-offline";
/** Сколько проверок подряд аппарат должен молчать: одно моргание Wi-Fi — не тревога. */
export const OFFICE_DESK_CONFIRM_TICKS = 2;
/** Утром аппарат включают не в первую минуту: первые 45 минут рабочего дня не судим. */
export const OFFICE_DESK_MORNING_GRACE_MIN = 45;

const toMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

export interface OfficeDeskWatchDeps {
  loadCreds?: typeof loadAriCredentials;
  listEndpoints?: (creds: NonNullable<Awaited<ReturnType<typeof loadAriCredentials>>>) => Promise<AriEndpoint[]>;
}

export interface OfficeDeskWatchResult {
  skipped: "not_extension" | "mobile_leg" | "no_station" | "station_unreachable" | "off_hours" | "morning_grace" | null;
  extension: string;
  online: boolean | null;
  alarmed: boolean;
}

/** Текущая серия «не на связи» в рабочее время — в памяти процесса, как счётчики stationHealth. */
let offlineStreak = 0;
let offlineSince: Date | null = null;

/** Только для тестов: забыть серию. */
export function resetOfficeDeskWatch(): void {
  offlineStreak = 0;
  offlineSince = null;
}

function resetStreak(): void {
  offlineStreak = 0;
  offlineSince = null;
}

async function resolveAlarm(): Promise<void> {
  await prisma.errorLog.updateMany({
    where: { source: "telephony", dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY, resolvedAt: null },
    data: { resolvedAt: new Date() },
  });
}

/** Одна проверка. Наружу бросает только сбой базы (тик ловит его сам). */
export async function watchOfficeDeskPhone(now: Date = new Date(), deps: OfficeDeskWatchDeps = {}): Promise<OfficeDeskWatchResult> {
  const extension = await incomingPrimaryExtension();
  const result: OfficeDeskWatchResult = { skipped: null, extension, online: null, alarmed: false };
  if (!extension) {
    // Приём ушёл на очередь — сторожить нечего; открытая тревога больше не правда.
    resetStreak();
    await resolveAlarm();
    return { ...result, skipped: "not_extension" };
  }
  // Есть мобильное плечо владельца — звонок дойдёт до человека и при выключенной
  // трубке: это не та поломка, ради которой сторож (18.11.2026).
  if (await incomingPrimaryHasMobileLeg(extension)) {
    resetStreak();
    await resolveAlarm();
    return { ...result, skipped: "mobile_leg" };
  }
  const creds = await (deps.loadCreds ?? loadAriCredentials)();
  if (!creds) return { ...result, skipped: "no_station" };

  let endpoints: AriEndpoint[];
  try {
    endpoints = await (deps.listEndpoints ?? listEndpointsRetrying)(creds);
  } catch {
    return { ...result, skipped: "station_unreachable" };
  }
  const online = agentDeviceOnline(endpoints, extension);
  result.online = online;
  if (online) {
    resetStreak();
    await resolveAlarm();
    return result;
  }

  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { workHoursStart: true, workHoursEnd: true, companyDaysOff: true },
  });
  const start = settings?.workHoursStart ?? "09:30";
  const end = settings?.workHoursEnd ?? "18:00";
  const inHours = isWithinDushanbeWindow(start, end, now) && !isDayOff(now, { companyDaysOff: settings?.companyDaysOff ?? [] });
  if (!inHours) {
    // Открытую тревогу не закрываем: аппарат по-прежнему выключен, утром она та же.
    resetStreak();
    return { ...result, skipped: "off_hours" };
  }

  // «С какого времени» — с первой проверки рабочего дня, где он молчал (и в утренней отсрочке тоже).
  offlineSince ??= now;
  const sinceStart = (toMinutes(dushanbeTimeString(now)) - toMinutes(start) + 1440) % 1440;
  if (sinceStart < OFFICE_DESK_MORNING_GRACE_MIN) return { ...result, skipped: "morning_grace" };
  offlineStreak += 1;
  if (offlineStreak < OFFICE_DESK_CONFIRM_TICKS) return result;

  const open = await prisma.errorLog.findFirst({
    where: { source: "telephony", dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY, resolvedAt: null },
    select: { id: true },
  });
  if (!open) {
    const message =
      `Офисный аппарат ${extension} не на связи с ${dushanbeTimeString(offlineSince)} — незнакомые звонки и звонки из WhatsApp ` +
      "сейчас никто не примет. Включите трубку и проверьте Wi-Fi в офисе.";
    await logSystemError("telephony", message, { dedupKey: OFFICE_DESK_OFFLINE_ALARM_KEY });
    // Директору — тем же уведомлением и тем же признаком, что у проверки аппарата приёма
    // (agentMobileFallback.ts): не чаще раза в сутки на аппарат. Хозяин этой тревоги — здесь.
    await notifyDirectorsAboutUnreachablePrimary(extension, `${message} ${PRIMARY_UNREACHABLE_CALL_PATH}`);
  }
  result.alarmed = true;
  return result;
}
