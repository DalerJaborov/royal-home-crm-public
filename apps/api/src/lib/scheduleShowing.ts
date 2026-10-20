import { prisma } from "../db.js";
import { refreshClientStatus } from "./clientAutoStatus.js";
import { closeStaleNextActions } from "./nextActionAutoClose.js";
import { hasConflictingShowing, SHOWING_AUTOBOOK_CONFLICT_WINDOW_MS } from "./showingBooking.js";
import { logSystemError } from "./systemError.js";
import { logTimeline } from "./timeline.js";

/**
 * Уже есть показ у этого клиента около этого времени? — проверка на дубль
 * (17-18.08.2026): без неё разбор звонка предохранялся только от повторного
 * предложения по ОДНОМУ и тому же звонку (см. alreadyBooked в ai/callAnalysis.ts),
 * а ручной показ, добавленный агентом до или после разбора, дублировался бы
 * автоматическим назначением.
 *
 * ПРАВИЛО ДУБЛЯ ОДНО НА ВСЮ CRM (унификация 22.08.2026). Раньше здесь жил свой
 * запрос с окном ±4 часа, а в lib/showingBooking.ts — свой, с окном в час: один и
 * тот же слот считался дублем или не считался в зависимости от того, КТО назначает
 * показ. Теперь запрос общий (findConflictingShowing), разной осталась только
 * ширина окна, и у этой разницы есть причина: здесь назначение полностью
 * автоматическое — и объект, и время модель вывела из расшифровки звонка, поэтому
 * робот получает окно шире и права осторожнее, чем живой человек в переписке.
 *
 * Переход на общий запрос попутно чинит три случая, где прежняя проверка
 * БЛОКИРОВАЛА законное назначение: она считала дублем отменённый показ (declinedAt
 * проставлен не у всех старых записей), уже проведённый и вовсе прошедший.
 */
export async function hasNearbyShowing(clientId: string, at: Date): Promise<boolean> {
  return hasConflictingShowing(clientId, at, { windowMs: SHOWING_AUTOBOOK_CONFLICT_WINDOW_MS });
}

/**
 * НАЗНАЧИТЬ ПОКАЗ — одно место на всю CRM.
 *
 * Показ заводится из четырёх разных мест: вручную из карточки, из окна «Как прошёл
 * звонок» (исход «Ждёт показ»), из окна «Назначьте показ» и из окна «Итог показа»
 * (ветки «Повторный показ» и «Подбираю другие объекты», ТЗ пп. 15.1 и 15.3).
 * Пока код был скопирован по местам, показ выглядел по-разному в зависимости от
 * того, откуда его назначили: где-то не рос счётчик просмотров объекта, где-то не
 * обновлялся автостатус клиента, а из «Итога показа» показ не создавался вовсе —
 * окно просто писало заметку «Повторный показ», и встречи не было ни в календаре,
 * ни в напоминаниях (аудит 14.08.2026).
 *
 * `nextAction: "Показ объекта"` обязателен: именно по непустому nextAction
 * напоминания (lib/meetingReminders.ts, TASK_WHERE) находят встречу и шлют пуши
 * за 2 часа и за 40 минут.
 */
export async function scheduleShowing(input: {
  clientId: string;
  agentId: string;
  propertyId: string;
  /** Момент показа — уже настоящий instant, не строка без пояса. */
  showingAt: Date;
  /** Откуда назначен — попадает в заметку, чтобы хронология читалась. */
  note: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const client = await prisma.client.findFirst({
      where: { id: input.clientId, deletedAt: null },
      select: { id: true, firstContactAt: true },
    });
    if (!client) return { ok: false, error: "Клиент не найден" };

    /**
     * ЗАЩИТА ОТ ДУБЛЕЙ ПРИ РУЧНОМ И АВТО-НАЗНАЧЕНИИ (аудит 02.09.2026, §7 S11/S17).
     *
     * Один физический показ может существовать двумя записями SHOWING: ручная запись
     * ДО звонка + автоназначение из разбора звонка. Без этой проверки scheduleShowing
     * создавал дубль, и агент получал два «Итога показа» по одной встрече. Проверка
     * идёт ДО транзакции создания: если конфликтующий показ уже есть, возвращаем
     * ошибку вместо второй записи. Окно ±4 часа (SHOWING_AUTOBOOK_CONFLICT_WINDOW_MS)
     * — то же, что у hasNearbyShowing: модель могла услышать «в шесть» как 18:05
     * против назначенных руками 18:00, а цена лишнего автопоказа выше цены пропуска.
     */
    const conflict = await hasConflictingShowing(client.id, input.showingAt, {
      windowMs: SHOWING_AUTOBOOK_CONFLICT_WINDOW_MS,
    });
    if (conflict) return { ok: false, error: "Показ на это время уже существует" };

    const created = await prisma.$transaction(async (tx) => {
      /**
       * ПЕРЕВЕДЕНО НА logTimeline МЕХАНИЧЕСКИ, БЕЗ СМЕНЫ АКТОРА (Б1, 17.09.2026).
       *
       * Показ заводится и агентом руками, и автоматически (разбор звонка ИИ,
       * ai/callAnalysis.ts) — по П-10 автоматический случай должен подписываться
       * kind "ai", а не "agent". Не сделано здесь: dashboard.ts/calendar.ts
       * читают показы агента строго по `agentId: ownAgentId` (счётчики недели,
       * «задачи на сегодня», лента) и НЕ понимают `subjectAgentId ?? agentId` —
       * смена kind тихо убрала бы автоназначенные показы с дашборда агента.
       * Полный перевод — Б2, вместе со сверкой этих потребителей (см. отчёт Б1).
       */
      const showing = await logTimeline({
        clientId: client.id,
        actor: { kind: "agent", agentId: input.agentId },
        type: "SHOWING",
        propertyId: input.propertyId,
        notes: input.note,
        nextAction: "Показ объекта",
        nextActionDate: input.showingAt,
        tx,
      });
      await tx.property.update({ where: { id: input.propertyId }, data: { viewsCount: { increment: 1 } } });
      await tx.client.update({
        where: { id: client.id },
        data: {
          lastContactAt: new Date(),
          ...(client.firstContactAt ? {} : { firstContactAt: new Date() }),
        },
      });
      return showing;
    });

    // Назначенный показ переводит клиента в «Горячий» — тем же механизмом, что и
    // показ, заведённый руками.
    void refreshClientStatus(client.id).catch((err) =>
      console.error("[scheduleShowing] автостатус после показа:", err instanceof Error ? err.message : err)
    );
    // ЗАКРЫТЬ СТАРЫЕ ПОДСКАЗКИ КЛИЕНТА (18.08.2026, см. lib/nextActionAutoClose.ts):
    // показ назначен — реальный контакт состоялся. Сама новая подсказка «Показ
    // объекта» исключена по id, чтобы не гасить сама себя.
    void closeStaleNextActions(client.id, created.id).catch((err) =>
      console.error("[scheduleShowing] закрытие старых подсказок:", err instanceof Error ? err.message : err)
    );
    return { ok: true };
  } catch (err) {
    /**
     * Объект успели удалить, пока агент выбирал его в списке. Итог, ради которого
     * показ назначался, при этом уже записан и теряться не должен: окно закроется,
     * а показ агент назначит из карточки. Молчать нельзя — иначе «показ назначен»
     * окажется неправдой, и об этом никто не узнает.
     */
    const message = err instanceof Error ? err.message : String(err);
    void logSystemError("api", `${input.note} — показ не назначен: ${message}`);
    return { ok: false, error: message };
  }
}
