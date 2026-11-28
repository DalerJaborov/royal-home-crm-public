import { prisma } from "../../db.js";
import { hasSearchableTail, phoneTail } from "../clientPhones.js";

/**
 * ДЕЖУРНЫЙ ОПЕРАТОР В ОДНОМ МЕСТЕ (28.11.2026). Модуль намеренно лёгкий (только база и разбор номера):
 * его читают и процесс api (автозвонок, просьбы клиента), и worker (уведомления), а телефонию api в worker
 * тянуть нельзя. Реэкспортируется из callbackConnect.ts.
 */
export interface DutyOperator {
  id: string;
  fullName: string;
  sipExtension: string;
  phone: string | null;
}

/**
 * ДЕЖУРНЫЙ ОПЕРАТОР: человек, который принимает звонки, когда никто не взял (владелец 28.11.2026:
 * «человек один»). Единая функция для просьб клиента «перезвоните» (callback-connect) и для
 * автоперезвона пропущенным (missedCallRedial.ts).
 *
 * Порядок: 1) только если incomingNoAnswerAction = forward или both: активный сотрудник с внутренним номером,
 * чей телефон совпадает с номером переадресации Settings.incomingForwardPhone (по хвосту номера, формат записи
 * не важен; при нескольких с одним хвостом: у кого есть внутренний номер, затем самый давний);
 * 2) запасной Settings.callbackOperatorAgentId (как было до 28.11). Номер переадресации пуст или
 * сотрудник не найден, не активен или без внутреннего номера: запасной вариант. Нет и его:
 * «дежурного нет», а не падение: очередь продолжает работать через баннер.
 */
/** Режимы, в которых «Кто принимает звонки, когда никто не взял» виден в Настройках и действует (ChannelsTab: forward, both). */
const FORWARD_MODES: readonly string[] = ["forward", "both"];

async function findDuty(requireSip: boolean): Promise<{ id: string; fullName: string; sipExtension: string | null; phone: string | null } | null> {
  const settings = await prisma.settings.findUnique({
    where: { id: "singleton" },
    select: { callbackOperatorAgentId: true, incomingForwardPhone: true, incomingNoAnswerAction: true },
  });
  const select = { id: true, fullName: true, sipExtension: true, phone: true, isActive: true } as const;
  const usable = (a: { id: string; fullName: string; sipExtension: string | null; phone: string | null; isActive: boolean } | null) =>
    a && a.isActive && (!requireSip || a.sipExtension) ? { id: a.id, fullName: a.fullName, sipExtension: a.sipExtension, phone: a.phone } : null;

  // Номер переадресации действует, только когда правило «если оператор не ответил» его использует.
  if (settings?.incomingForwardPhone && FORWARD_MODES.includes(settings.incomingNoAnswerAction) && hasSearchableTail(settings.incomingForwardPhone)) {
    const tail = phoneTail(settings.incomingForwardPhone);
    const candidates = await prisma.agent.findMany({
      where: { isActive: true, ...(requireSip ? { sipExtension: { not: null } } : {}) },
      select,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 500,
    });
    const same = candidates.filter((a) => a.phone && phoneTail(a.phone) === tail);
    // Несколько сотрудников с одним хвостом: берём того, кому можно звонить (есть внутренний номер), старшего по заведению.
    const found = usable(same.find((a) => a.sipExtension) ?? same[0] ?? null);
    if (found) return found;
  }

  const spareId = settings?.callbackOperatorAgentId;
  if (!spareId) return null;
  const spare = usable(await prisma.agent.findUnique({ where: { id: spareId }, select }));
  return spare ? { ...spare, id: spareId } : null;
}

/** Дежурный для НАБОРА: нужен внутренний номер, без него станции некому звонить. */
export async function loadDutyOperator(): Promise<DutyOperator | null> {
  const duty = await findDuty(true);
  return duty && duty.sipExtension ? { ...duty, sipExtension: duty.sipExtension } : null;
}

/**
 * Дежурный для УВЕДОМЛЕНИЙ и назначения просьб клиента. Сначала тот же человек, которому звонит станция
 * (loadDutyOperator), чтобы уведомление и звонок не расходились. Звонить некому (ни у кого нет внутреннего номера):
 * тот же порядок поиска без требования внутреннего номера, человек всё равно видит пуш и баннер.
 */
export async function loadDutyAgentId(): Promise<string | null> {
  return (await findDuty(true))?.id ?? (await findDuty(false))?.id ?? null;
}
