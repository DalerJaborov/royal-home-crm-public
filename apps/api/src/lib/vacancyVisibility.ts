/**
 * КТО ИЗ КАНДИДАТОВ ВИДЕН И В КАКОЙ КОРЗИНЕ — ОДНО ПРАВИЛО НА ВСЕ ЭКРАНЫ (02.10.2026).
 *
 * Раньше условия жили тремя копиями: список раздела «Вакансии»
 * (routes/vacancies.ts), красная цифра в сайдбаре (routes/dashboard.ts) и плитка
 * «Новые анкеты» пульта (routes/dashboardMissionControl.ts). Копии разошлись:
 * пульт считал ВСЕ NEW, включая отсеянных и анкеты без номера, а сайдбар — ещё и
 * тех, у кого допуск не решён, хотя вкладка по умолчанию («Подходят») их не
 * показывает. Цифра обещала кандидатов, которых на экране нет.
 *
 * РУЧНОЕ РЕШЕНИЕ ГЛАВНЕЕ ОТБОРА. eligibleOverride=true («Всё равно позвать»)
 * делает анкету прошедшей во всех корзинах и счётчиках. Бот пересчитывает
 * `eligible` на каждом ходе разговора, но `eligibleOverride` не трогает никогда —
 * поэтому решение человека переживает любую следующую запись бота.
 *
 * NULL И ОТРИЦАНИЯ. Каждое «не» здесь записано списком значений, а не `not`:
 * `NOT (eligible = false)` для NULL даёт в SQL не истину, а NULL, и строка молча
 * выпадает (поймано на проде 03.09.2026, см. routes/vacancies.ts).
 */
import type { Prisma } from "../generated/prisma/client.js";

type Where = Prisma.JobApplicationWhereInput;

/** NOT_CANDIDATE — «анкету завели по ошибке»: не виден нигде, кроме PATCH. */
export const NOT_ARCHIVED: Where = { status: { not: "NOT_CANDIDATE" } };

export const HAS_PHONE: Where = { AND: [{ phone: { not: null } }, { phone: { not: "" } }] };
export const NO_PHONE: Where = { OR: [{ phone: null }, { phone: "" }] };

/** Ручного «всё равно позвать» нет (null или снято). */
const NOT_OVERRIDDEN: Where = { OR: [{ eligibleOverride: null }, { eligibleOverride: false }] };

/** Прошёл отбор — сам или решением руководителя. */
export const EFFECTIVELY_ELIGIBLE: Where = { OR: [{ eligible: true }, { eligibleOverride: true }] };

/** Отсеян отбором и руководитель не позвал его вопреки этому. */
export const EFFECTIVELY_REJECTED: Where = { AND: [{ eligible: false }, NOT_OVERRIDDEN] };

/** Прошёл или ещё не решено — прежний фильтр «по умолчанию» без корзины. */
export const PASSES_FILTER: Where = { OR: [{ eligible: null }, { eligible: true }, { eligibleOverride: true }] };

/** Корзина «Подходят»: прошёл отбор и есть номер, по которому звонить. */
export const BUCKET_FIT: Where = { AND: [EFFECTIVELY_ELIGIBLE, HAS_PHONE] };

/** Корзина «Дособрать»: допуск не решён — или прошёл, но номера ещё нет. */
export const BUCKET_INCOMPLETE: Where = {
  OR: [{ AND: [{ eligible: null }, NOT_OVERRIDDEN] }, { AND: [EFFECTIVELY_ELIGIBLE, NO_PHONE] }],
};

/** Корзина «Не подходят». */
export const BUCKET_REJECTED: Where = EFFECTIVELY_REJECTED;

export type VacancyBucket = "fit" | "incomplete" | "rejected";

export const BUCKET_WHERE: Record<VacancyBucket, Where> = {
  fit: BUCKET_FIT,
  incomplete: BUCKET_INCOMPLETE,
  rejected: BUCKET_REJECTED,
};

/**
 * «НОВЫЕ КАНДИДАТЫ» ДЛЯ ВСЕХ СЧЁТЧИКОВ — ровно то, что человек увидит, открыв
 * раздел: все новые отклики, включая незаполненные анкеты. Автоматический
 * старый отбор больше не прячет их из очереди. Сайдбар добавляет «с последнего
 * визита» (`extra`); решение об отказе хранится в HR-стадии, отдельно от eligible.
 */
export function visibleNewCandidatesWhere(extra: Where = {}): Where {
  // Всё — элементами одного AND: спред `extra` с собственным AND/OR молча
  // затёр бы условия корзины (тот же класс, что разобран в routes/vacancies.ts).
  return { AND: [extra, { status: "NEW" }, NOT_ARCHIVED] };
}
