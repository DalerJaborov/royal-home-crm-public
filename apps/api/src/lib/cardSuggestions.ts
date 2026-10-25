import { Prisma } from "../generated/prisma/client.js";
import {
  PROPERTY_TYPE_LABELS,
  parsePermissionOverrides,
  resolvePermissions,
  type PropertyType,
  type Role,
} from "@royal-home/shared";
import { buildCardFillSuggestion } from "../ai/cardFill.js";
import { prisma } from "../db.js";
import { logSystemError } from "./systemError.js";
import { logTimeline } from "./timeline.js";
import { describeError } from "./describeError.js";
import { logSystemAudit } from "./audit.js";
import { cardCurrencyConverter } from "./money.js";

/**
 * «ИИ услышал в разговоре — и сразу записал в карточку». МОЛЧА И ЦЕЛИКОМ.
 *
 * ДВА РЕШЕНИЯ ВЛАДЕЛЬЦА, КОТОРЫЕ ЗДЕСЬ НАДО ЗНАТЬ ОБА:
 *  · 07.08.2026 — «заполнять с подтверждением агента». Распознавание живой речи
 *    ошибается, особенно на смеси таджикского и русского, и неверный бюджет
 *    уводит подбор объектов в сторону.
 *  · 12.09.2026 — ЭТО ОТМЕНЕНО ИМ ЖЕ, окончательно. Дословно: «блок „После
 *    разговора: проверьте, верно ли поняли клиента“ я уже сто раз убираю, чтобы
 *    он исчез у всех и больше не появлялся. Я специально плачу за дорогую
 *    модель, чтобы она не переспрашивала».
 *
 * Промежуточные шаги (12.08.2026 — отменено обязательное окно, 14.08.2026 —
 * граница «пустое пишем, спорное спрашиваем») перечислены в теле
 * buildSuggestionFromCall: они объясняют, почему подтверждение вообще было и
 * почему возвращать его нельзя.
 *
 * КАК СЕЙЧАС. Всё, что машина услышала иначе, чем записано в карточке, ложится в
 * карточку сразу — ни окна, ни баннера, ни кнопки. Вместо вопроса остаётся СЛЕД:
 * строка в хронологии клиента «ИИ уточнил карточку по разговору: …» с перечнем
 * «было → стало», запись CLIENT_AI_UPDATED в истории карточки (автор «Система»)
 * со структурным before/after и само предложение с цитатами клиента в базе.
 *
 * Для переписки с ботом молчаливое заполнение было и раньше
 * (lib/clientAutopilot.ts): там текст точный, спорить не о чем.
 */

/** Как в тексте хронологии выглядит «поля не было». Одной строкой, чтобы «было
 *  «—»» везде читалось одинаково. */
const EMPTY_VALUE = "—";

/**
 * Разговоры короче этого не разбираем: это «алло, перезвоню», и предложение будет
 * пустым.
 *
 * Было тридцать секунд — и это оказалось слишком много. У владельца 10.08.2026 из
 * трёх звонков одному клиенту два (0:18 и 0:21) не дали ни предложения по карточке,
 * ни разбора, хотя во втором из них договорились о показе на сегодня. Пятнадцать
 * секунд — всё ещё отсекает случайные нажатия и «не туда попал», но уже пропускает
 * короткий деловой разговор, ради которого всё это и делается. Пустое предложение
 * ничего не стоит: ниже стоит проверка «в разговоре нет данных для карточки».
 */
const MIN_TALK_SECONDS = 15;

/**
 * Строит предложение по разговору и кладёт его в очередь к агенту.
 *
 * Наружу не бросает ничего: это фоновая работа после звонка, и уронить обработчик
 * событий АТС она права не имеет. Причина отказа уходит в журнал, а не в тишину.
 */
export async function buildSuggestionFromCall(params: {
  clientId: string;
  agentId: string;
  interactionId: string;
  talkSeconds: number;
}): Promise<{ created: boolean; reason?: string }> {
  const { clientId, agentId, interactionId, talkSeconds } = params;
  try {
    if (talkSeconds < MIN_TALK_SECONDS) return { created: false, reason: "разговор слишком короткий" };

    // Одно предложение на разговор: повторный разбор завалил бы агента одинаковыми
    // карточками (interactionId уникален и на уровне БД, но проверка дешевле ошибки).
    const already = await prisma.cardSuggestion.findUnique({ where: { interactionId } });
    if (already) return { created: false, reason: "предложение по этому звонку уже есть" };

    const baseline = await prisma.client.findFirst({ where: { id: clientId, deletedAt: null }, select: { updatedAt: true, mutationRevision: true } });
    if (!baseline) return { created: false, reason: "клиент не найден" };
    const suggestion = await buildCardFillSuggestion(clientId);
    if (suggestion.aiUnavailable) return { created: false, reason: "ИИ недоступен" };

    // Клиент в разговоре ничего о себе не сказал — предлагать нечего, и пустая
    // карточка «подтвердите ничего» раздражала бы сильнее, чем помогала.
    const hasAnything =
      suggestion.budgetMin !== null ||
      suggestion.budgetMax !== null ||
      suggestion.districtId !== null ||
      suggestion.rooms !== null ||
      suggestion.type !== null ||
      !!suggestion.address ||
      !!suggestion.notes;
    if (!hasAnything) return { created: false, reason: "в разговоре нет данных для карточки" };

    // Предлагаем только то, чего в карточке ещё нет либо что отличается от записанного:
    // подтверждать уже известное — пустая работа.
    // deletedAt: null (27.08.2026) — соседний путь того же конвейера
    // (ai/callAnalysis.ts) этот фильтр уже имеет. Конвейер запускается через
    // минуту-две после отбоя — ровно то окно, когда карточку успевают удалить,
    // и без фильтра предложение молча дописывало карточку из Корзины (бюджет,
    // район, комнаты) и писало CLIENT_AI_UPDATED в её историю.
    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
      select: {
        updatedAt: true,
        mutationRevision: true,
        // Имя — для подписи обязательного окна: «окно по uuid» человек не поймёт.
        fullName: true,
        // Кому карточка принадлежит сейчас: молчаливую запись делаем только от
        // имени того, кто вправе её менять (проверка прав ниже, 12.09.2026).
        assignedAgentId: true,
        // Валюта карточки: суммы от ИИ приходят в сомони и должны лечь в неё.
        currency: true,
        budgetMin: true,
        budgetMax: true,
        desiredDistrictId: true,
        desiredRooms: true,
        desiredType: true,
        requirementsNotes: true,
        address: true,
      },
    });
    if (!client) return { created: false, reason: "клиент не найден" };
    // The model used an earlier snapshot. Do not overwrite edits made while it was running.
    if (client.mutationRevision !== baseline.mutationRevision || client.updatedAt.getTime() !== baseline.updatedAt.getTime()) return { created: false, reason: "карточка изменилась во время разбора" };

    const sameNumber = (a: Prisma.Decimal | null, b: number | null) =>
      a !== null && b !== null && Number(a) === b;

    /**
     * Что ИИ услышал иначе, чем записано в карточке. Совпавшее отбрасываем: просить
     * подтвердить уже известное — пустая работа.
     *
     * Ориентир (`address`) здесь на общих правах — раньше он был исключением и
     * заполнял только пустое поле. Решение владельца 14.08.2026 сняло исключение
     * вместе с ответом на вопрос, что это поле вообще значит: не адрес проживания
     * клиента, а ориентир, где он ищет жильё («рядом с ЦУМом»). Такой ориентир
     * уточняется от разговора к разговору ровно как район и бюджет, и молчать о
     * расхождении по нему незачем — тем более что перезаписи теперь и нет.
     */
    /**
     * ВАЛЮТА КАРТОЧКИ (аудит №4, 27.08). Разбор звонка, как и разбор переписки,
     * всегда отдаёт сомони (промт ai/cardFill.ts). Путь ПЕРЕПИСКИ пересчитывал
     * их в валюту карточки, а этот — писал как есть: у премиум-клиента с
     * карточкой в долларах «миллион сомони» превращался в миллион ДОЛЛАРОВ, и
     * подбор объектов уходил в пустоту. Сравнение с уже записанным бюджетом
     * тоже шло в разных валютах — расхождение находилось на ровном месте.
     */
    const toCardCurrency = await cardCurrencyConverter(client.currency);
    const heardBudgetMin = suggestion.budgetMin === null ? null : toCardCurrency(suggestion.budgetMin);
    const heardBudgetMax = suggestion.budgetMax === null ? null : toCardCurrency(suggestion.budgetMax);

    const heard = {
      budgetMin: sameNumber(client.budgetMin, heardBudgetMin) ? null : heardBudgetMin,
      budgetMax: sameNumber(client.budgetMax, heardBudgetMax) ? null : heardBudgetMax,
      districtId: client.desiredDistrictId === suggestion.districtId ? null : suggestion.districtId,
      rooms: client.desiredRooms === suggestion.rooms ? null : suggestion.rooms,
      type: client.desiredType === suggestion.type ? null : suggestion.type,
      notes: client.requirementsNotes === suggestion.notes ? null : suggestion.notes,
      address: (client.address ?? null) === (suggestion.address ?? null) ? null : (suggestion.address ?? null),
    };

    /**
     * ИИ ПИШЕТ ВСЁ УСЛЫШАННОЕ САМ, МОЛЧА — решение владельца 12.09.2026.
     *
     * ХРОНОЛОГИЯ РЕШЕНИЙ ПО ЭТОМУ МЕСТУ (не удалять: без неё правка выглядит
     * случайной и её «чинят» обратно):
     *  · 07.08.2026 — заполнять ТОЛЬКО с подтверждения агента: распознавание
     *    речи ошибается, особенно на смеси таджикского и русского.
     *  · 12.08.2026 — обязательное окно отменено, пустые поля заполняются сами.
     *  · 14.08.2026 — граница: расхождение с уже записанным значением остаётся
     *    предложением (баннер «После разговора: проверьте, верно ли поняли
     *    клиента») и ждёт нажатия агента.
     *  · 12.09.2026 — ЭТА ГРАНИЦА ОТМЕНЕНА ВЛАДЕЛЬЦЕМ ЦЕЛИКОМ. Дословно: «блок
     *    „После разговора: проверьте, верно ли поняли клиента“ я уже сто раз
     *    убираю, чтобы он исчез у всех и больше не появлялся. Я специально плачу
     *    за дорогую модель, чтобы она не переспрашивала».
     *
     * Что это значит в коде: `toFill`/`toConfirm` больше нет, развилки по «пусто
     * или занято» нет, предложение НИКОГДА не остаётся в состоянии pending. Всё,
     * что машина услышала иначе, чем записано в карточке, пишется в карточку сразу.
     *
     * ЧТО ОСТАЛОСЬ ВМЕСТО ПОДТВЕРЖДЕНИЯ — СЛЕД, А НЕ ВОПРОС:
     *  · строка в хронологии клиента («ИИ уточнил карточку по разговору:
     *    ориентир, запрос») с перечнем «было → стало» по каждому полю — её видно
     *    там же, где сам звонок, и она переживает любую перезагрузку;
     *  · запись CLIENT_AI_UPDATED в истории карточки (автор «Система») со
     *    структурным before/after — по ней поле возвращается руками за десять
     *    секунд; отдельного механизма отката правок в CRM нет ни у одного поля
     *    карточки, и заводить его ради этого одного пути не стали;
     *  · само предложение с цитатами клиента остаётся в базе (status="applied")
     *    и доступно через GET /clients/:id/card-suggestions — видно, из каких
     *    слов клиента машина это взяла.
     */
    type CardField = keyof typeof heard;
    const proposed = (Object.keys(heard) as CardField[]).filter((f) => heard[f] !== null);

    /**
     * В предложение пишем ВСЁ услышанное, а не только спорное.
     *
     * Предложение это ещё и запись: «вот что машина расслышала в этом разговоре»,
     * с цитатами клиента рядом. Урезав её, мы бы стёрли след ровно тех полей,
     * которые заполнились сами и которые никто больше не проверит.
     */
    const data = heard;

    if (proposed.length === 0) return { created: false, reason: "новых сведений нет" };

    /**
     * ПРАВА: ИИ ПИШЕТ ОТ ИМЕНИ АГЕНТА И НЕ ВПРАВЕ ЗАЛЕЗТЬ ТУДА, КУДА АГЕНТ НЕ ХОДИТ.
     *
     * Разбор запускается через минуту-две после отбоя — окно, в котором клиента
     * успевают переназначить другому риелтору или вернуть в общий пул. Молчаливая
     * запись от имени агента, который карточку больше не ведёт, это ровно то, что
     * маршруты карточки запрещают (canAccessAssignedAgent в auth/middleware.ts):
     * чужую карточку менять нельзя. Проверка стоит здесь, потому что фоновый путь
     * в middleware не заходит вовсе.
     *
     * Полей, закрытых отдельным правом, разбор не трогает: `clients.viewPhone` и
     * `clients.viewOrigin` закрывают телефон и источник, а сюда попадают только
     * бюджет, район, комнаты, тип, ориентир и запрос — они открыты всем, кому
     * открыта сама карточка. Появится поле под своим правом — список полей задан
     * прямо в `heard` выше, и добавлять его туда придётся осознанно.
     */
    const author = await prisma.agent.findUnique({
      where: { id: agentId },
      select: { role: true, permissions: true },
    });
    if (!author) return { created: false, reason: "автор разговора не найден" };
    const authorPermissions = resolvePermissions(
      author.role as Role,
      parsePermissionOverrides(author.permissions)
    );
    if (!authorPermissions.has("clients.viewAll") && client.assignedAgentId !== agentId) {
      return { created: false, reason: "клиент больше не закреплён за автором разговора" };
    }

    // Клиенту звонят не один раз: сегодня уточнили бюджет, через два дня — район.
    // Каждый разговор рождает своё предложение, и прежние закрываются как
    // устаревшие: новое построено с учётом ВСЕХ последних разговоров (cardFill.ts)
    // и уже содержит всё, что было в прежнем.
    const [, created] = await prisma.$transaction([
      prisma.cardSuggestion.updateMany({
        where: { clientId, status: "pending" },
        data: { status: "superseded", resolvedAt: new Date() },
      }),
      prisma.cardSuggestion.create({
        data: {
          clientId,
          agentId,
          interactionId,
          ...data,
          // Цитаты клиента — опора следа: по ним видно, из чего машина это взяла.
          evidence: suggestion.evidence.slice(0, 3),
        },
      }),
    ]);

    /**
     * Что именно поменялось — одним списком «поле: было → стало». Он идёт сразу в
     * два места: в строку хронологии (человеку) и в CLIENT_AI_UPDATED (истории
     * карточки, структурно).
     */
    const applied: Prisma.ClientUncheckedUpdateManyInput = {};
    const changes: {
      field: string;
      label: string;
      before: unknown;
      after: unknown;
      /** Те же значения человеческими словами — для строки хронологии. Район в
       *  `before`/`after` это uuid, и «было „7f3a…“» в ленте бесполезно. */
      beforeText: string;
      afterText: string;
    }[] = [];
    const money = (value: Prisma.Decimal | null) => (value === null ? null : Number(value));

    // Имена районов — одним запросом на оба id сразу (старый и новый), а не по
    // одному внутри перечисления: правило репозитория про N+1 действует и здесь.
    const districtIds = [client.desiredDistrictId, heard.districtId].filter(
      (id): id is string => typeof id === "string"
    );
    const districtNames = new Map<string, string>(
      districtIds.length === 0
        ? []
        : (
            await prisma.district.findMany({
              where: { id: { in: districtIds } },
              select: { id: true, name: true },
            })
          ).map((d) => [d.id, d.name])
    );
    const districtText = (id: string | null) => (id === null ? EMPTY_VALUE : (districtNames.get(id) ?? id));
    const typeText = (value: string | null) =>
      value === null ? EMPTY_VALUE : (PROPERTY_TYPE_LABELS[value as PropertyType] ?? value);
    const plainText = (value: string | number | null) =>
      value === null || value === "" ? EMPTY_VALUE : String(value);

    if (heard.budgetMin !== null) {
      applied.budgetMin = heard.budgetMin;
      changes.push({
        field: "budgetMin",
        label: "бюджет от",
        before: money(client.budgetMin),
        after: heard.budgetMin,
        beforeText: plainText(money(client.budgetMin)),
        afterText: plainText(heard.budgetMin),
      });
    }
    if (heard.budgetMax !== null) {
      applied.budgetMax = heard.budgetMax;
      changes.push({
        field: "budgetMax",
        label: "бюджет до",
        before: money(client.budgetMax),
        after: heard.budgetMax,
        beforeText: plainText(money(client.budgetMax)),
        afterText: plainText(heard.budgetMax),
      });
    }
    if (heard.districtId !== null) {
      applied.desiredDistrictId = heard.districtId;
      changes.push({
        field: "districtId",
        label: "район",
        before: client.desiredDistrictId,
        after: heard.districtId,
        beforeText: districtText(client.desiredDistrictId),
        afterText: districtText(heard.districtId),
      });
    }
    if (heard.rooms !== null) {
      applied.desiredRooms = heard.rooms;
      changes.push({
        field: "rooms",
        label: "комнат",
        before: client.desiredRooms,
        after: heard.rooms,
        beforeText: plainText(client.desiredRooms),
        afterText: plainText(heard.rooms),
      });
    }
    if (heard.type !== null) {
      applied.desiredType = heard.type as Prisma.ClientUpdateInput["desiredType"];
      changes.push({
        field: "type",
        label: "тип",
        before: client.desiredType,
        after: heard.type,
        beforeText: typeText(client.desiredType),
        afterText: typeText(heard.type),
      });
    }
    if (heard.address) {
      applied.address = heard.address;
      changes.push({
        field: "address",
        label: "ориентир",
        before: client.address ?? null,
        after: heard.address,
        beforeText: plainText(client.address ?? null),
        afterText: plainText(heard.address),
      });
    }
    if (heard.notes) {
      applied.requirementsNotes = heard.notes;
      changes.push({
        field: "notes",
        label: "запрос",
        before: client.requirementsNotes ?? null,
        after: heard.notes,
        beforeText: plainText(client.requirementsNotes ?? null),
        afterText: plainText(heard.notes),
      });
    }

    if (changes.length > 0) {
      /**
       * СЛЕД В ХРОНОЛОГИИ — обязательная часть решения 12.09.2026, а не украшение.
       *
       * Без баннера агент узнаёт об изменении единственным способом: строкой в той
       * же ленте, где лежит сам звонок. Пишем обычной SYSTEM-записью (тем же
       * приёмом, что «подборка отправлена» в routes/clients) — она уже приходит
       * вместе с карточкой и не требует ни нового маршрута, ни нового экрана.
       *
       * Перечень «было → стало» лежит прямо в тексте, а не в отдельном поле:
       * хронология показывает `notes` целиком, и «посмотреть, что изменилось»
       * работает без единой новой кнопки. Автор записи — ИИ (kind "ai", П-10,
       * 17.09.2026): разбор сделала модель по расшифровке, агент руками этого
       * не писал, хотя разговор вёл он (subjectAgentId) — правки не должны
       * читаться как «агент Умед изменил», если правил ИИ (дефект «ИИ-правки
       * наследуют автора звонка», docs/audit/recon-17-09/04-timeline-authorship.md §b.3).
       */
      const summaryLine = `ИИ уточнил карточку по разговору: ${changes.map((c) => c.label).join(", ")}`;
      const detailLines = changes.map((c) => `• ${c.label}: было «${c.beforeText}» → стало «${c.afterText}»`);

      // Карточка, отметка «применено» и след — одной транзакцией: при сбое
      // посередине карточка бы поменялась, а объяснения этому в CRM не осталось.
      const saved = await prisma.$transaction(async (tx) => {
        const changed = await tx.client.updateMany({ where: { id: clientId, deletedAt: null, updatedAt: client.updatedAt, mutationRevision: client.mutationRevision }, data: applied });
        if (changed.count !== 1) {
          await tx.cardSuggestion.update({ where: { id: created.id }, data: { status: "superseded", resolvedAt: new Date() } });
          return false;
        }
        await tx.cardSuggestion.update({
          where: { id: created.id },
          data: { status: "applied", resolvedAt: new Date() },
        });
        await logTimeline({
          clientId,
          actor: { kind: "ai", source: "card-suggestion", subjectAgentId: agentId },
          type: "SYSTEM",
          notes: [summaryLine, ...detailLines].join("\n"),
          tx,
        });
        return true;
      });
      if (!saved) return { created: false, reason: "карточка изменилась перед сохранением разбора" };

      // История карточки: структурный before/after. По нему поле возвращается
      // руками, если машина расслышала неверно. Автор — «Система».
      logSystemAudit("CLIENT_AI_UPDATED", "Client", clientId, {
        interactionId,
        changes: changes as unknown as Prisma.InputJsonValue,
      });
    }
    return { created: true };
  } catch (err) {
    void logSystemError("ai", `Не удалось разобрать разговор для карточки: ${describeError(err)}`);
    return { created: false, reason: "ошибка разбора" };
  }
}

/**
 * Решение агента по предложению — ОДНО на оба места, где оно показывается.
 *
 * Предложение видно дважды: обязательным окном поверх CRM (PendingSummary
 * kind="card_fill") и баннером внутри карточки клиента. Это одно и то же предложение,
 * поэтому и закрываться должно вместе: подтвердил в карточке — окно гаснет, закрыл
 * окно — баннер исчезает. Пока логика жила только в маршрутах карточки, окно после
 * подтверждения продолжало висеть и требовало подтвердить то же самое второй раз.
 *
 * Возвращает список полей, которые реально записаны в карточку, — его показывает
 * интерфейс («записано: бюджет, район»).
 */
export async function resolveCardSuggestion(params: {
  suggestionId: string;
  clientId: string;
  action: "apply" | "dismiss";
  /** Что записать в карточку — то, с чем согласился агент, возможно поправленное. */
  card?: {
    budgetMin?: number | null;
    budgetMax?: number | null;
    districtId?: string | null;
    rooms?: number | null;
    type?: string | null;
    address?: string | null;
    notes?: string | null;
  };
  /**
   * Агент правил поля руками («Поправить»), а не просто согласился с машиной.
   *
   * ЗАЧЕМ ЭТОТ ПРИЗНАК СУЩЕСТВУЕТ. `null` в `card` значит две противоположные
   * вещи, и различить их по самому значению нельзя:
   *
   *  • при согласии с предложением — «ИИ про это поле ничего не услышал»
   *    (в сохранённом предложении обнулено и всё, что совпало с карточкой);
   *  • при ручной правке — «убрать значение из карточки», законное действие.
   *
   * До 12.08.2026 разницы не делалось, и первый случай молча выполнял второй:
   * нажатие «Всё верно, записать» по предложению, где ИИ услышал только район,
   * СТИРАЛО из карточки бюджет, комнаты, тип и запрос клиента. Владелец увидел
   * это как «окно не меняет карточку и не сохраняет старое значение».
   */
  manualEdit?: boolean;
}): Promise<string[]> {
  const { suggestionId, clientId, action, card, manualEdit } = params;

  const data: Prisma.ClientUpdateInput = {};
  if (action === "apply" && card) {
    // Согласие с машиной пишет только то, что она РЕАЛЬНО услышала: пустое поле
    // здесь — это отсутствие сведений, а не приказ очистить карточку. Ручная
    // правка, наоборот, значит ровно то, что агент видит в форме.
    const wanted = (value: unknown) => value !== undefined && (manualEdit || value !== null);

    if (wanted(card.budgetMin)) data.budgetMin = card.budgetMin;
    if (wanted(card.budgetMax)) data.budgetMax = card.budgetMax;
    if (wanted(card.districtId)) {
      data.desiredDistrict = card.districtId ? { connect: { id: card.districtId } } : { disconnect: true };
    }
    if (wanted(card.rooms)) data.desiredRooms = card.rooms;
    if (wanted(card.type)) data.desiredType = card.type as Prisma.ClientUpdateInput["desiredType"];
    if (wanted(card.address)) data.address = card.address;
    if (wanted(card.notes)) data.requirementsNotes = card.notes;
  }

  // Карточка, предложение и обязательное окно закрываются одной транзакцией: при
  // сбое посередине поля бы уже поменялись, а предложение осталось висеть — агент
  // подтвердил бы его второй раз и затёр собственные правки.
  await prisma.$transaction([
    ...(Object.keys(data).length > 0 ? [prisma.client.update({ where: { id: clientId }, data })] : []),
    prisma.cardSuggestion.update({
      where: { id: suggestionId },
      data: { status: action === "apply" ? "applied" : "dismissed", resolvedAt: new Date() },
    }),
    // updateMany, а не update: окна может не быть вовсе (предложение по переписке с
    // ботом, старое предложение до 10.08.2026), и это не ошибка.
    prisma.pendingSummary.updateMany({
      where: { kind: "card_fill", subjectId: suggestionId, doneAt: null },
      data: { doneAt: new Date() },
    }),
  ]);

  return Object.keys(data);
}

/** Ожидающее решения предложение по клиенту — то, что показывается в карточке. */
export async function pendingSuggestionFor(clientId: string) {
  return prisma.cardSuggestion.findFirst({
    where: { clientId, status: "pending" },
    orderBy: { createdAt: "desc" },
    include: { district: { select: { id: true, name: true } } },
  });
}

/**
 * ЗДЕСЬ БЫЛА `pendingSuggestionConflictsFor` — «то же предложение, но без полей,
 * которые карточка уже содержит». Она обслуживала ровно один экран: баннер
 * «После разговора: проверьте, верно ли поняли клиента» в карточке клиента.
 *
 * Баннер отменён владельцем 12.09.2026 («я специально плачу за дорогую модель,
 * чтобы она не переспрашивала»), вместе с ним ушли GET /clients/:id/card-suggestion,
 * POST .../apply и POST .../dismiss. Спорных полей больше не бывает: разбор пишет
 * всё сам (buildSuggestionFromCall выше), и предложение не остаётся в состоянии
 * pending ни на секунду. Возвращать эту функцию значит возвращать баннер.
 */

/**
 * История предложений ИИ по карточке — п.8 ТЗ «Путь покупателя»: агент должен видеть,
 * что машина предлагала раньше и что он с этим решил, не поднимая расшифровки звонков.
 *
 * Новые сверху; лимит обязателен (правило репозитория — любой роут с массивом
 * ограничивает выборку). У активного клиента разборов немного (один на звонок,
 * а звонков в день — единицы), поэтому 20 штук с запасом покрывают всю практическую
 * историю; кто листает глубже — редкий случай, не повод городить пагинацию по курсору.
 */
export async function suggestionHistoryFor(clientId: string, limit = 20) {
  return prisma.cardSuggestion.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { district: { select: { id: true, name: true } } },
  });
}
