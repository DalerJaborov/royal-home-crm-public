/**
 * Общие хелперы маршрутов клиента (Г2, docs/architecture-blueprint.md §1.2):
 * их используют несколько групп routes/clients/*. Код перенесён из
 * routes/clients.ts verbatim — только импорты и export.
 */
import type { Request } from "express";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "../../db.js";
import { dushanbeDateString } from "../../lib/dushanbeTime.js";
import { CLIENT_KIND_LABELS, CLIENT_PHONE_MASK_CHAR, formatClientCode, INACTIVE_REASON_LABELS, type ClientKind, type InactiveReason } from "@royal-home/shared";
import { can } from "../../auth/middleware.js";
import { HIDDEN_ORIGIN_NAME, withHiddenOrigin } from "../../lib/clientOrigin.js";
import { isPlaceholderName } from "../../lib/placeholderName.js";
import { toTjs, type MoneyContext } from "../../lib/money.js";
import { maskClientPhone, maskPhonesInText, phoneSafeText } from "../../lib/clientPhone.js";
import { findPhoneConflicts, type PhoneConflict } from "../../lib/clientPhones.js";

/**
 * «ВИДЕТЬ ВСЕ» — НЕ ЗНАЧИТ «ПИСАТЬ ВО ВСЕ».
 *
 * Доступ к чужой карточке решался одним `scopeToOwnAgent`, а он смотрит на право
 * `clients.viewAll`. У руководства оно идёт в паре с `clients.assign`, и разницы не
 * было видно — но у службы безопасности `viewAll` есть, а `assign` нет. Служба
 * безопасности разбирает, почему клиент ушёл («купил сам», «через другое
 * агентство»), и при этом могла переписать разбираемую карточку, дописать в неё
 * разговор, передать клиента другому агенту или отправить его в неактивные. Проверка,
 * которая может менять проверяемое, независимой не является; в пресете роли прямо
 * написано «видеть — но не менять».
 *
 * Право на запись в ЧУЖУЮ карточку — у того, кто распределяет лидов
 * (`clients.assign`): это то же руководство, которому уже разрешено чинить состояние
 * покупателя, когда автоматика ошиблась. Своя карточка агента сюда не попадает: у
 * него `ownAgentId` задан, и его разбирает проверка строкой выше по каждому маршруту.
 *
 * Возвращает текст отказа или null, если писать можно.
 */
export function foreignWriteDenied(
  req: Request,
  client: { assignedAgentId: string | null },
  ownAgentId: string | undefined
): string | null {
  if (ownAgentId) return null; // рядовой агент — его ограничивает своя проверка
  if (can(req, "clients.assign")) return null;
  if (client.assignedAgentId === req.agent!.id) return null;
  return "Чужую карточку клиента ведёт закреплённый агент или руководитель";
}

export function normalizePhone(phone: string) {
  return phone.replace(/[^\d]/g, "");
}

// Правило видимости телефона живёт в lib/clientPhone.ts — одно на всю CRM.
// Здесь только используется: раньше оно было местной функцией этого файла, и все
// остальные маршруты (календарь, сделки, инбокс, дашборд) отдавали номер целиком.
export const maskPhone = maskClientPhone;

/** Телефон клиента агенту не показывается ВООБЩЕ — решение владельца от 07.08.2026,
 * принятое вместе с запуском телефонии. Раньше номер скрывался только до принятия
 * лида, а дальше открывался целиком, и агент мог позвонить со своего мобильного мимо
 * CRM: разговор не записывался, в хронологии не оставалось следа, а при уходе
 * сотрудника клиент уходил вместе с ним — база агентства на деле лежала в личных
 * телефонных книжках.
 *
 * Теперь связь с клиентом идёт только через кнопку «Позвонить»: номер набирает АТС,
 * агент его не видит. Маска (`+992•••••57`) оставлена намеренно вместо пустого места —
 * по последним цифрам агент отличит двух Мадин в списке и поймёт, что номер вообще
 * есть, а карточка не пустая.
 *
 * Номер целиком видит тот, у кого есть право `clients.viewPhone` — по умолчанию это
 * директор и администрация. Право отдельное, а не «видит всех клиентов»: директор
 * может выдать его конкретному сотруднику в Настройках → Сотрудники, не открывая ему
 * заодно чужие карточки, и наоборот.
 *
 * whatsappPhone (номер, с которого клиент пишет — подставляется из wa_id, см.
 * lib/whatsappPhone.ts) проходит через ЭТО ЖЕ правило: второй механизм видимости
 * означал бы второе место, где можно ошибиться. */
export function presentClient<
  T extends {
    phone: string;
    whatsappPhone?: string | null;
    extraPhones?: string[];
    email?: string | null;
    /** Сводка «Коротко ИИ» и причина оценки — свободный текст, написанный моделью
     *  по переписке и хронологии, где клиент диктует номер словами. */
    aiInsight?: string | null;
    aiScoreReason?: string | null;
    /** «Заметки» карточки — туда CRM кладёт дословные цитаты клиента (A5 ниже). */
    requirementsNotes?: string | null;
    acceptedAt: Date | null;
    /** Нужны только для канонической подписи заглушки-имени ниже (shortId+kind) —
     *  необязательны в типе, чтобы вызовы, которые их не выбирали, не ломались. */
    shortId?: number;
    kind?: ClientKind;
  },
>(client: T, canSeePhone: boolean, canSeeOrigin = true): T & { pendingAcceptance: boolean } {
  const pending = client.acceptedAt === null;
  /**
   * ОТКУДА ПРИШЁЛ КЛИЕНТ — ОТДЕЛЬНОЕ ПРАВО, И ОНО НЕ СОВПАДАЕТ С ТЕЛЕФОНОМ
   * (решение владельца 17.08.2026, см. lib/clientOrigin.ts).
   *
   * Скрытие стоит ЗДЕСЬ, а не в маршрутах: presentClient — единственное место, где
   * карточка превращается в ответ, и ровно поэтому телефон закрыт надёжно. Урок
   * записан в lib/clientPhone.ts дословно: «правило, записанное в одном маршруте,
   * не является правилом».
   *
   * Умолчание `true` — чтобы вызов без третьего аргумента ничего не прятал: тогда
   * забытый аргумент даёт прежнее поведение, а не молча ломает карточку
   * руководителя. Места, где право надо учесть, перечислены вызовами ниже.
   */
  const shown = withHiddenOrigin(client as T & { fullName?: string; source?: string | null }, canSeeOrigin);
  if (canSeePhone) {
    return { ...shown, pendingAcceptance: pending };
  }
  return {
    ...shown,
    phone: maskPhone(client.phone),
    ...(client.whatsappPhone ? { whatsappPhone: maskPhone(client.whatsappPhone) } : {}),
    // Запасные номера — такой же телефон клиента, как главный, и закрываются той
    // же маской. Отдать их открытыми значило бы обойти clients.viewPhone списком:
    // права на номер нет, а позвонить всё равно можно.
    ...(client.extraPhones ? { extraPhones: client.extraPhones.map(maskPhone) } : {}),
    // НОМЕР ВНУТРИ ИМЕНИ (владелец 20.08.2026, живой случай: агент видел
    // «Входящий +992910001003»). Карточки незнакомых звонивших CRM заводит сама,
    // и до сегодняшнего дня клала в имя ОТКРЫТЫЙ номер — маскировка поля `phone`
    // такое имя не трогала вовсе. Новые карточки заводятся уже с маской (см.
    // lib/telephony/incomingCalls.ts), эта строка закрывает заведённые раньше.
    //
    // НИК СОЦСЕТИ В ИМЕНИ — ОТДЕЛЬНЫЙ СЛУЧАЙ (17.09.2026, жалоба «Позвонить: @•••••»
    // на Главной агента). У карточек, заведённых до 17.08.2026, `fullName` иногда
    // и есть сам ник («@nozil760») — `maskPhonesInText` считает такое совпадением
    // MENTION_RE (тот же разбор, что для «@username» в переписке, где ник ведёт в
    // обход агентства) и стирает его целиком в «@•••••»: технически имя «замаскировано»
    // как и было задумано, но агенту это уже ни о чём не говорит — только что было
    // видно, что карточка не пустая, теперь и это пропало. Настоящую заглушку
    // (lib/placeholderName.ts — тот же признак, что не даёт автозаполнению принять
    // «@ник» за имя) заменяем КАНОНИЧЕСКОЙ подписью карточки («Покупатель ПК-000058»,
    // тот же формат, что уже ставится при создании — см. messengers/conversation.ts),
    // а не гоняем через маскировку номеров: там нечего скрывать, там нечего было
    // и показывать. Без shortId/kind (вызов их не выбрал) — нейтральная подпись
    // withHiddenOrigin, чтобы не показать «@•••••» ни в каком виде.
    ...(typeof (shown as { fullName?: string }).fullName === "string"
      ? {
          fullName: isPlaceholderName((shown as { fullName: string }).fullName)
            ? client.shortId !== undefined && client.kind
              ? `${CLIENT_KIND_LABELS[client.kind]} ${formatClientCode(client.shortId, client.kind)}`
              : HIDDEN_ORIGIN_NAME
            : maskPhonesInText((shown as { fullName: string }).fullName),
        }
      : {}),
    /**
     * НОМЕР В ПЕРЕСКАЗЕ ОТ ИИ (владелец 30.08.2026, та же болезнь, что с именем
     * карточки 20.08.2026). Сводка «Коротко ИИ» пишется по сырой хронологии и
     * сырой переписке (ai/scoring.ts) — клиент диктует номер в чат или голосом, и
     * модель честно переносит его в текст. Поле `phone` рядом при этом закрыто
     * маской: правило обходилось не дырой в правиле, а тем, что номер лежал не в
     * том поле.
     *
     * Вход модели с этого же дня чистится в ai/scoring.ts — здесь закрываются
     * сводки, написанные ДО сегодня и уже лежащие в базе.
     */
    ...(typeof client.aiInsight === "string" ? { aiInsight: phoneSafeText(client.aiInsight, false) } : {}),
    ...(typeof client.aiScoreReason === "string"
      ? { aiScoreReason: phoneSafeText(client.aiScoreReason, false) }
      : {}),
    /**
     * НОМЕР В «ЗАМЕТКАХ» (глубокая проверка 02.10.2026, A5). requirementsNotes —
     * тоже свободный текст, и в него CRM пишет сама: дословный комментарий из
     * Instagram и с сайта («продаю 2-комн, звоните 93…»), сводку звонка,
     * требования, вынутые ИИ из расшифровки. Маскировалось поле только в
     * предложениях реактивации — карточка и список отдавали номер целиком.
     * Обратный путь (форма шлёт показанный текст при сохранении) разбирает
     * restoreMaskedNotes ниже.
     */
    ...(typeof client.requirementsNotes === "string"
      ? { requirementsNotes: phoneSafeText(client.requirementsNotes, false) }
      : {}),
    // Почта закрыта только до принятия: она не даёт увести клиента мимо CRM так,
    // как даёт телефон, а переписываться агенту иногда нужно.
    email: pending ? null : client.email,
    pendingAcceptance: pending,
  };
}

/**
 * «ЗАМЕТКИ», ПОКАЗАННЫЕ СО СКРЫТЫМ НОМЕРОМ, ИХ ЖЕ СОХРАНЕНИЕМ НЕ ПЕРЕПИСЫВАЮТСЯ
 * (глубокая проверка 02.10.2026, A5 — тот же приём, что у имени карточки, №67).
 *
 * Кому номер не виден, тот получает requirementsNotes с «•» вместо цифр, а форма
 * карточки шлёт поле при каждом сохранении. Без этой функции правка бюджета
 * затирала бы настоящий номер точками.
 *
 * Сверка — по строкам: строка без «•» принимается как написана (человек её и
 * набрал), строка с «•» должна совпасть с показанной версией какой-то строки
 * оригинала — тогда на её место встаёт оригинал. Не совпала — это правка
 * скрытого места, которую восстановить нельзя: возвращаем null, маршрут отвечает
 * отказом. Цитаты с номерами CRM дописывает отдельными строками, так что
 * дописать или поправить соседнюю строку можно всегда.
 */
export function restoreMaskedNotes(sent: string, original: string | null): string | null {
  if (!sent.includes(CLIENT_PHONE_MASK_CHAR)) return sent;
  if (!original) return null;
  if (sent === phoneSafeText(original, false)) return original;
  const shownLines = new Map<string, string>();
  for (const line of original.split("\n")) {
    const shown = phoneSafeText(line, false);
    if (!shownLines.has(shown)) shownLines.set(shown, line);
  }
  const restored: string[] = [];
  for (const line of sent.split("\n")) {
    if (!line.includes(CLIENT_PHONE_MASK_CHAR)) {
      restored.push(line);
      continue;
    }
    const back = shownLines.get(line);
    if (back === undefined) return null;
    restored.push(back);
  }
  return restored.join("\n");
}

/** Сумма, по которой сравниваются бюджеты, — в сомони. Верхняя граница «до»
 *  главнее: именно её называет клиент, а нижняя часто вообще не заполнена.
 *  null = бюджет не указан вовсе, это «неизвестно», а не ноль. */
export function budgetSortKey(
  client: { budgetMin: Prisma.Decimal | null; budgetMax: Prisma.Decimal | null; currency: string },
  money: MoneyContext
): number | null {
  const raw = client.budgetMax ?? client.budgetMin;
  return raw === null ? null : toTjs(raw, client.currency, money);
}

/**
 * ОДИН НОМЕР — ОДИН ХОЗЯИН, И ОБ ЭТОМ ГОВОРЯТ ВСЛУХ (18.08.2026).
 *
 * `Client.phone` уникален базой, но запасные номера (`extraPhones`) лежат массивом,
 * и уникальности на них нет — см. lib/clientPhones.ts. Без этой проверки агент мог
 * бы вписать себе чужой номер, и входящий звонок начал бы находить ДВЕ карточки:
 * маршрутизация в такой ситуации отказывается переводить (`ambiguous_phone`), то
 * есть клиент вместо своего агента снова попадает в общую очередь. Молча.
 *
 * Что именно проверяем и чего НЕ проверяем: совпадение главного номера с ЧУЖИМ
 * ГЛАВНЫМ здесь пропускаем сознательно — у него свой, более мягкий путь выше
 * (409 «уже существует» на создании, предупреждение с `force`). Ловим то, чего
 * раньше не ловил никто: чужой номер, попадающий в запасные, и чужой ЗАПАСНОЙ,
 * попадающий в главный.
 *
 * Сообщение называет карточку по номеру и имени — иначе «номер занят» превращается
 * в тупик: агент не знает, к кому идти. Сам номер в тексте маскируем по тому же
 * праву, что и везде (`clients.viewPhone`), а имя и ПК-номер остаются: они и так
 * видны в поиске по CRM, а без них ошибка бесполезна.
 */
export function describePhoneConflicts(conflicts: PhoneConflict[], canSeePhone: boolean): string {
  const parts = conflicts.map((c) => {
    const shown = canSeePhone ? c.phone : maskPhone(c.phone);
    const where = c.isPrimary ? "основной номер" : "запасной номер";
    return `${shown} — это ${where} клиента ПК-${c.shortId} (${c.fullName})`;
  });
  return `Номер уже принадлежит другому клиенту. ${parts.join("; ")}. ` +
    "Один номер может быть только у одной карточки — уберите его или объедините карточки.";
}

/**
 * ПОЧЕМУ КАРТОЧКА НЕ НАХОДИТСЯ (18.09.2026, задание В §f п.2, разведка 17.09
 * `docs/audit/recon-17-09/03-hidden-states.md` §(a)). Одна функция на все
 * состояния, из-за которых карточка выпадает из обычных списков держателя —
 * та же причина, что у presentClient: посчитать один раз здесь и переиспользовать
 * ТОТ ЖЕ текст в строке списка, в шапке карточки и в уведомлении (пункт 3
 * задания) — иначе три места неизбежно разъедутся в формулировках.
 *
 * Порядок проверок — от самого «глухого» состояния к самому мягкому: Корзина
 * возвращается первой, потому что удалённая карточка может одновременно быть
 * и INACTIVE, и LOST — тексту нужен один самый важный повод, не все сразу.
 */
export type HiddenReasonKind =
  | "trashed"
  | "other"
  | "inactive"
  | "deferred"
  | "lost"
  | "dealClosed"
  | "archived"
  | "escalated"
  | "securityReview";

export interface HiddenReasonInfo {
  kind: HiddenReasonKind;
  /** Короткая подпись для строки списка («В Корзине», «Неактивен»…). */
  label: string;
  /** Причина/контекст, если есть («кто и когда», «причина: …»). */
  detail?: string;
}

/** Что видит агент после «отложить клиента»: дата возврата — по Душанбе, не по UTC. */
export function deferredReturnMessage(deferredUntil: Date): string {
  return `Клиент отложен — вернётся в работу автоматически ${dushanbeDateString(deferredUntil)} или раньше, если напишет сам`;
}

export function computeHiddenReason(client: {
  deletedAt: Date | null;
  deletedByName?: string | null;
  kind: ClientKind;
  status: string;
  workStatus: string;
  inactiveReasonKey?: string | null;
  deferredUntil?: Date | null;
  deferredReason?: string | null;
  escalatedAt?: Date | null;
  acceptedAt: Date | null;
  securityReview?: string | null;
}): HiddenReasonInfo | null {
  if (client.deletedAt) {
    return {
      kind: "trashed",
      label: "В Корзине",
      detail: client.deletedByName
        ? `Удалил(а) ${client.deletedByName}, ${dushanbeDateString(client.deletedAt)}`
        : `Удалена ${dushanbeDateString(client.deletedAt)}`,
    };
  }
  if (client.kind === "OTHER") {
    return { kind: "other", label: "Прочее обращение", detail: "Не покупатель и не продавец — вне ваших списков" };
  }
  if (client.securityReview) {
    return { kind: "securityReview", label: "На проверке СБ", detail: "Разбирает служба безопасности" };
  }
  if (client.status === "LOST") {
    return { kind: "lost", label: "Потерян", detail: "Раздел «Потерянные» — предел передач или отказ" };
  }
  if (client.status === "DEAL_CLOSED") {
    return { kind: "dealClosed", label: "Сделка закрыта" };
  }
  if (client.status === "ARCHIVED") {
    return { kind: "archived", label: "В архиве" };
  }
  if (client.escalatedAt && !client.acceptedAt) {
    return { kind: "escalated", label: "Эскалирован руководителю", detail: "Никто не принял вовремя — решает руководитель" };
  }
  if (client.workStatus === "DEFERRED") {
    return {
      kind: "deferred",
      label: "Отложен",
      detail: client.deferredUntil
        ? `До ${dushanbeDateString(client.deferredUntil)}${client.deferredReason ? `: ${client.deferredReason}` : ""}`
        : client.deferredReason ?? undefined,
    };
  }
  if (client.workStatus === "INACTIVE") {
    const reasonLabel = client.inactiveReasonKey
      ? INACTIVE_REASON_LABELS[client.inactiveReasonKey as InactiveReason] ?? client.inactiveReasonKey
      : undefined;
    return { kind: "inactive", label: "Неактивен", detail: reasonLabel };
  }
  return null;
}

/**
 * Занятые номера из запроса. Возвращает готовый текст ошибки или null.
 * Один запрос в базу на весь список номеров (findPhoneConflicts) — на создании
 * клиента их до одиннадцати, и по запросу на каждый было бы N+1.
 */
export async function phoneOwnershipError(
  req: Parameters<typeof can>[0],
  data: { phone?: string; extraPhones?: string[] },
  exceptClientId?: string
): Promise<string | null> {
  const extra = data.extraPhones ?? [];
  if (!data.phone && extra.length === 0) return null;
  const conflicts = await findPhoneConflicts([...(data.phone ? [data.phone] : []), ...extra], exceptClientId);
  // Совпадение основного номера с основным номером другой карточки — «мягкое»
  // только при СОЗДАНИИ: там дубль склеивается с существующей карточкой. На
  // правке (exceptClientId) склейки нет — точный номер ронял запрос 500, тот же
  // номер в другой записи молча заводил второго клиента с этим телефоном
  // (аудит 23.09.2026, №20).
  const hard = exceptClientId ? conflicts : conflicts.filter((c) => c.phone !== data.phone || !c.isPrimary);
  if (hard.length > 0) return describePhoneConflicts(hard, can(req, "clients.viewPhone"));
  // Карточка из Корзины с тем же основным номером: живой поиск её не видит, а
  // уникальность номера в базе не даст сохранить — отказ словами, а не 500.
  if (exceptClientId && data.phone) {
    const trashed = await prisma.client.findFirst({
      where: { phone: data.phone, id: { not: exceptClientId }, deletedAt: { not: null } },
      select: { id: true },
    });
    if (trashed) return "Этот номер записан у карточки в Корзине — восстановите её или укажите другой номер";
  }
  return null;
}
