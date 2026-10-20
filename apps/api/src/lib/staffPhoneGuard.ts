import { prisma, type TxClient } from "../db.js";
import { hasSearchableTail, phoneTail } from "./clientPhones.js";
import { maskClientPhone } from "./clientPhone.js";

/**
 * НОМЕР СОТРУДНИКА — НЕ НОМЕР КЛИЕНТА, НИГДЕ (найдено на проде 14.09.2026).
 *
 * Агент Маъруф позвонил в офис со своего номера «пошутить» — CRM завела клиента
 * №289 и его же номер поставила продавцом в объекты №98/№99. Карточка теперь не
 * удаляется («у продавца есть объекты в работе»). На проде тот же класс дыры ещё
 * дважды: клиент №38 с номером Нурмухаммада (заведён входящим звонком), объекты
 * №41/№44 с номерами сотрудников как контакт собственника.
 *
 * ОДНА ФУНКЦИЯ, А НЕ ПРОВЕРКА В КАЖДОМ РОУТЕ — тот же урок, что и в
 * lib/clientPhone.ts (правило, записанное в одном маршруте, не является
 * правилом): номер приходит в CRM минимум девятью разными путями (форма
 * клиента, ручной набор, квалификация звонка, автоответчик, импорт, лид из
 * канала, продавец в мастере объекта) — второе определение «что считать
 * номером сотрудника» неизбежно разошлось бы с первым.
 *
 * СРАВНЕНИЕ ПО ХВОСТУ, КАК ВЕЗДЕ В CRM (phoneTail, lib/clientPhones.ts):
 * «900001042», «+992900001042», «992 90 000 10 42» — один и тот же номер, а
 * форма записи зависит от того, откуда он пришёл (набрали руками, приехал со
 * станции, вписан агентом).
 *
 * УВОЛЕННЫЙ — УЖЕ НЕ «СВОЙ» НОМЕР. Уволенные (Agent.isActive=false) сознательно
 * не блокируют: человек ушёл из компании и вправе стать её клиентом, как любой
 * посторонний. Проверяем только действующих сотрудников.
 */

export interface StaffPhoneMatch {
  agentId: string;
  fullName: string;
  phone: string;
  /** Номер из проверяемого списка, на котором сработало совпадение — не всегда
   *  совпадает с `phone` (сотрудник и клиент могли записать его по-разному). */
  matchedPhone: string;
}

export const STAFF_PHONE_ERROR_CODE = "STAFF_PHONE" as const;

interface StaffPhoneEntry {
  agentId: string;
  fullName: string;
  phone: string;
  tail: string;
}

// Only the extended client's agent reader is needed; neither nested
// transaction methods nor a raw generated TransactionClient are required.
type Tx = Pick<TxClient, "agent">;

/**
 * ОДИН запрос на весь список действующих сотрудников, а не по одному на
 * каждый проверяемый номер (сотрудников десятки, не тысячи — см. шапку файла).
 * Дальше сравнение хвостов идёт в памяти, без LIKE в цикле.
 */
async function loadActiveStaffPhones(tx?: Tx): Promise<StaffPhoneEntry[]> {
  const client: Tx = tx ?? prisma;
  const agents = await client.agent.findMany({
    where: { isActive: true },
    select: { id: true, fullName: true, phone: true },
  });
  return agents
    .map((a) => ({ agentId: a.id, fullName: a.fullName, phone: a.phone, tail: phoneTail(a.phone) }))
    .filter((a) => a.tail.length > 0);
}

function matchAgainstStaff(
  staff: StaffPhoneEntry[],
  phones: Array<string | null | undefined>
): StaffPhoneMatch | null {
  for (const phone of phones) {
    if (!phone || !hasSearchableTail(phone)) continue; // обрывок — не номер, пропускаем
    const tail = phoneTail(phone);
    const digits = phone.replace(/\D/g, "");
    // Хвост совпал — этого достаточно, только если хотя бы одна из записей
    // «голая» (девять цифр без кода страны: «900001042» против «+992900001042»).
    // Когда ОБЕ записи длиннее хвоста, это два полных номера, и они обязаны
    // совпасть целиком: у «+992 973 …» и «+992 975 …» с одинаковыми последними
    // девятью цифрами разные коды оператора — это разные люди, а не один.
    const hit = staff.find((s) => {
      if (s.tail !== tail) return false;
      const staffDigits = s.phone.replace(/\D/g, "");
      return staffDigits.length <= tail.length || digits.length <= tail.length || staffDigits === digits;
    });
    if (hit) return { agentId: hit.agentId, fullName: hit.fullName, phone: hit.phone, matchedPhone: phone };
  }
  return null;
}

/**
 * Есть ли среди номеров номер действующего сотрудника. Одноразовая проверка —
 * запрос агентов внутри. Для мест, где номер проверяется НЕСКОЛЬКО раз за один
 * вызов (импорт CSV на тысячи строк, приём лида из канала: главный номер +
 * запасные + WhatsApp), берите `loadStaffPhoneChecker` ниже — один запрос на
 * всю операцию, а не `await findStaffPhone` в цикле по списку.
 */
export async function findStaffPhone(
  phones: Array<string | null | undefined>,
  tx?: Tx
): Promise<StaffPhoneMatch | null> {
  if (!phones.some((p) => p && hasSearchableTail(p))) return null; // нечего сравнивать — не ходим в базу
  const staff = await loadActiveStaffPhones(tx);
  if (staff.length === 0) return null;
  return matchAgainstStaff(staff, phones);
}

/**
 * Тот же список сотрудников, загруженный ОДИН раз, — для мест с массовой или
 * многократной проверкой в пределах одной операции (routes/import.ts,
 * services/leads/intake.ts). Возвращает чистую функцию сравнения в памяти,
 * без похода в базу на каждый вызов.
 */
export async function loadStaffPhoneChecker(
  tx?: Tx
): Promise<(phones: Array<string | null | undefined>) => StaffPhoneMatch | null> {
  const staff = await loadActiveStaffPhones(tx);
  return (phones) => (staff.length === 0 ? null : matchAgainstStaff(staff, phones));
}

/** Текст отказа для человека. Номер маскируем тем же правилом, что и везде в
 *  CRM (lib/clientPhone.ts) — рядовой сотрудник не должен увидеть чужой номер
 *  открытым в тексте ошибки. */
export function staffPhoneError(m: StaffPhoneMatch): string {
  return `Номер ${maskClientPhone(m.matchedPhone)} принадлежит сотруднику ${m.fullName} — номера сотрудников нельзя заводить как клиентов`;
}

/**
 * Для автоматических путей, у которых нет `res` под рукой (приём лида из
 * канала — services/leads/intake.ts): карточка не создаётся, и об этом нужно
 * сообщить вызывающему БЕЗ изменения его сигнатуры (`{ clientId, created }`
 * на полтора десятка мест, трогать которые не входит в эту задачу). Бросаем
 * типизированную ошибку; HTTP-путь (POST /website-lead) ловит её один раз
 * в общем обработчике app.ts и превращает в 409, остальные пути (бот,
 * мессенджеры) уже оборачивают createLeadFromChannel в try/catch и получают
 * то же «не смогли оформить заявку», что и при любом другом сбое.
 */
export class StaffPhoneLeadError extends Error {
  readonly code = STAFF_PHONE_ERROR_CODE;
  readonly match: StaffPhoneMatch;

  constructor(match: StaffPhoneMatch) {
    super(staffPhoneError(match));
    this.name = "StaffPhoneLeadError";
    this.match = match;
  }
}
