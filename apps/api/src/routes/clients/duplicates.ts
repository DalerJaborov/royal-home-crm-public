/** Дубликаты: GET /duplicates, similar-notes, POST /merge (Г2, §1.2). Перенос verbatim. */
import { Router } from "express";
import { clientsMergeSchema } from "@royal-home/shared";
import { prisma } from "../../db.js";
import { can, requireAuth, requirePermission } from "../../auth/middleware.js";
import { fuzzySimilarClientNotes } from "../../lib/fuzzySearch.js";
import { logAudit } from "../../lib/audit.js";
import { maskPhone, normalizePhone, presentClient } from "./shared.js";
import { clientNamePhoneSafe, phoneSafeText } from "../../lib/clientPhone.js";
import { withHiddenOrigin } from "../../lib/clientOrigin.js";
import { findAgentsWithPermission } from "../../lib/recipients.js";
import { closeLeadPushNotifications } from "../../push.js";

/**
 * «⚠️ Похоже на дубликат карточки» уходит всем с правом clients.merge
 * (services/leads/intake.ts) — без закрытия висело бы у ОСТАЛЬНЫХ проверяющих
 * даже после того, как один из них уже решил вопрос (найдено 07.09.2026, тот
 * же класс, что и lead-escalated-*). Закрываем с обеих сторон пары: тег
 * привязан к id только что созданной карточки, но при чтении из шторки
 * заранее не угадать, какая из двух это была.
 */
async function closeSimilarClientsAlert(idA: string, idB: string): Promise<void> {
  const reviewers = await findAgentsWithPermission("clients.merge");
  await closeLeadPushNotifications(
    reviewers.flatMap((id) => [
      { agentId: id, tag: `similar-clients-${idA}` },
      { agentId: id, tag: `similar-clients-${idB}` },
    ])
  );
}
import { DUPLICATES_SCAN_LIMIT, findDuplicateClientGroups } from "../../lib/duplicateClients.js";
import { ClientMergeOpenDealError, ClientMergeTrashedError, mergeClients } from "../../lib/clientMerge.js";
import { findFuzzyDuplicatePairs } from "../../lib/duplicateReview.js";

export const duplicatesRouter = Router();

/**
 * GET /clients/duplicates — группы вероятных дубликатов. Только админ/менеджер:
 * объединение затрагивает клиентов разных агентов. Сама группировка (совпадение
 * телефона/Telegram) вынесена в lib/duplicateClients.ts — её же переиспользует
 * еженедельное напоминание руководству (lib/duplicatesWeeklyDigest.ts, владелец
 * 06.09.2026): этот экран сам по себе ничего не толкает, кнопка «Дубли»
 * появляется только тогда, когда человек уже открыл «Клиенты».
 *
 * reason:"identity" — совпадение нормализованного телефона (последние 9 цифр) ИЛИ
 * телеграм-аккаунта (chatId/username). Только эти два сигнала однозначно
 * идентифицируют человека — совпадение одного лишь ФИО НЕ считается дубликатом:
 * распространённые имена (Далер, Умед…) регулярно принадлежат разным людям.
 *
 * reason:"nameAndPhone" (раздел L, уровень 4, 03.09.2026) — сигнал слабее: похожее
 * (не идентичное) имя И похожий (не идентичный) номер — последние 7 цифр совпадают,
 * а не 9 (см. lib/duplicateReview.ts::findFuzzyDuplicatePairs). Ловит опечатку в
 * номере или расхождение написания имени, которые "identity" не поймает. Именно
 * поэтому это ОТДЕЛЬНАЯ, более осторожная группа — слияние всё равно решает человек.
 */
duplicatesRouter.get("/duplicates", requireAuth, requirePermission("clients.merge"), async (req, res) => {
  const found = await findDuplicateClientGroups();
  if (found.overLimit) {
    return res.status(503).json({
      error: `Слишком много клиентов для полного поиска дублей (${found.candidateCount}, потолок ${DUPLICATES_SCAN_LIMIT}). Нужна доработка на SQL-агрегацию — сообщите разработчику.`,
    });
  }

  // Право clients.merge не даёт права на телефоны: без маски этот экран отдавал
  // открытые номера всякому, кто может объединять дубликаты, — обход правила
  // из lib/clientPhone.ts. Две последние цифры остаются: по ним человек и
  // отличает дубликаты друг от друга.
  const canSeePhone = can(req, "clients.viewPhone");
  // Имя — тем же правом, что номер (глубокая проверка 02.10.2026, класс A11):
  // у старых карточек незнакомых звонивших номер лежит в самом имени.
  const masked = <C extends { phone: string; fullName: string }>(c: C): C => ({
    ...c,
    phone: maskPhone(c.phone),
    fullName: clientNamePhoneSafe(c.fullName, false),
  });
  // Откуда пришёл клиент — отдельное право clients.viewOrigin (lib/clientOrigin.ts).
  // Группа дублей отдавала source и Telegram-идентификаторы всякому с clients.merge,
  // а ник в имени прятала только маска номера (аудит Codex 04.10.2026, ACCESS-01).
  const canSeeOrigin = can(req, "clients.viewOrigin");
  const hideOrigin = <C extends { fullName: string; source?: string | null; telegramChatId?: string | null; telegramUsername?: string | null }>(
    c: C
  ): C => (canSeeOrigin ? c : { ...withHiddenOrigin(c, false), telegramChatId: null, telegramUsername: null });
  const present = <C extends { phone: string; fullName: string; source?: string | null; telegramChatId?: string | null; telegramUsername?: string | null }>(
    c: C
  ): C => hideOrigin(canSeePhone ? c : masked(c));
  const identityGroups = found.groups.map((g) => ({
    reason: "identity" as const,
    clients: g.clients.map(present),
  }));

  /**
   * РАЗДЕЛ L, УРОВЕНЬ 4 (03.09.2026, план вечерней сессии) — вероятные дубли по
   * похожему (не идентичному) номеру + похожему имени, слабее группы "identity"
   * выше. На том же уже выкачанном списке — второй SQL-проход не нужен.
   * Пары, обе стороны которых и так попали в "identity", не повторяем — это уже
   * показано как надёжное совпадение выше.
   */
  const fuzzyPairs = findFuzzyDuplicatePairs(found.scanned).filter(
    ([a, b]) => found.clientToGroup.get(a.id) === undefined || found.clientToGroup.get(a.id) !== found.clientToGroup.get(b.id)
  );
  const fuzzyGroups = fuzzyPairs.map(([a, b]) => ({
    reason: "nameAndPhone" as const,
    clients: [a, b].map(present),
  }));

  res.json([...identityGroups, ...fuzzyGroups]);
});

/**
 * GET /clients/:id/similar-notes — карточки с очень похожим текстом «Заметки»
 * (requirementsNotes), не пойманные обычной проверкой телефона/Telegram выше.
 * Живой случай владельца (19.08.2026): продавец написал в чат, потом позвонил
 * с другого номера — две разные карточки, но заметки почти дословно совпадают
 * («квартира переделана в 3-комнатную…»). Это только подсказка для баннера на
 * карточке — слияние всё равно делает агент вручную через POST /merge с force.
 */
duplicatesRouter.get("/:id/similar-notes", requireAuth, requirePermission("clients.merge"), async (req, res) => {
  const client = await prisma.client.findUnique({ where: { id: req.params.id } });
  if (!client || client.deletedAt) {
    return res.status(404).json({ error: "Клиент не найден" });
  }
  if (!client.requirementsNotes?.trim()) {
    return res.json([]);
  }
  const candidates = await fuzzySimilarClientNotes(client.id, client.requirementsNotes);
  if (candidates.length === 0) return res.json([]);

  const canSeePhone = can(req, "clients.viewPhone");
  const byId = new Map(candidates.map((c) => [c.id, c.similarity]));
  // Отклонённые руководителем пары («это разные люди») не всплывают снова —
  // см. Client.dismissedSimilarClientIds.
  const dismissed = new Set(client.dismissedSimilarClientIds);
  const clients = await prisma.client.findMany({
    // deletedAt — кандидаты отобраны SQL-ом с тем же условием, но карточка могла
    // уйти в Корзину между двумя запросами (глубокая проверка 02.10.2026, A5).
    where: { id: { in: candidates.map((c) => c.id).filter((id) => !dismissed.has(id)) }, deletedAt: null },
    select: { id: true, shortId: true, fullName: true, phone: true, kind: true, requirementsNotes: true },
  });
  // Имя и заметка — тем же правом, что телефон (A5): «Похожие по заметкам» видит
  // руководство с clients.merge, у которого clients.viewPhone по пресету нет, а
  // в заметке лежит дословная цитата клиента с номером, в имени старых карточек —
  // сам номер (lib/clientPhone.ts).
  const result = clients
    .map((c) => ({
      ...(canSeePhone
        ? c
        : {
            ...c,
            phone: maskPhone(c.phone),
            fullName: clientNamePhoneSafe(c.fullName, false),
            requirementsNotes: phoneSafeText(c.requirementsNotes, false),
          }),
      similarity: byId.get(c.id) ?? 0,
    }))
    .sort((a, b) => b.similarity - a.similarity);
  res.json(result);
});

/**
 * POST /clients/:id/similar-notes/:otherId/dismiss — «это разные люди»: руководитель
 * посмотрел на баннер похожих заметок и решил, что совпадение случайное. Пишем
 * СИММЕТРИЧНО в обе карточки — иначе отклонённая с одной стороны пара продолжала
 * бы всплывать со второй (similarity не различает, кто на кого смотрит).
 */
duplicatesRouter.post(
  "/:id/similar-notes/:otherId/dismiss",
  requireAuth,
  requirePermission("clients.merge"),
  async (req, res) => {
    const { id, otherId } = req.params;
    if (id === otherId) return res.status(400).json({ error: "Нельзя отклонить карточку саму с собой" });
    const [client, other] = await Promise.all([
      prisma.client.findUnique({ where: { id }, select: { dismissedSimilarClientIds: true } }),
      prisma.client.findUnique({ where: { id: otherId }, select: { dismissedSimilarClientIds: true } }),
    ]);
    if (!client || !other) return res.status(404).json({ error: "Клиент не найден" });

    await prisma.$transaction([
      prisma.client.update({
        where: { id },
        data: { dismissedSimilarClientIds: { set: [...new Set([...client.dismissedSimilarClientIds, otherId])] } },
      }),
      prisma.client.update({
        where: { id: otherId },
        data: { dismissedSimilarClientIds: { set: [...new Set([...other.dismissedSimilarClientIds, id])] } },
      }),
    ]);
    void closeSimilarClientsAlert(id, otherId).catch((err) =>
      console.error("[push] закрытие предупреждения о дубликате после «это разные люди»:", err)
    );
    res.json({ dismissed: true });
  }
);

/**
 * POST /clients/merge — переносит взаимодействия и сделки дубликата в основного
 * клиента, дозаполняет пустые поля и удаляет дубликат. Необратимо → админ/менеджер.
 */
duplicatesRouter.post("/merge", requireAuth, requirePermission("clients.merge"), async (req, res) => {
  const parsed = clientsMergeSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные данные", details: parsed.error.flatten() });
  }
  const { primaryId, duplicateId, force } = parsed.data;

  const [primary, duplicate] = await Promise.all([
    prisma.client.findUnique({ where: { id: primaryId } }),
    prisma.client.findUnique({ where: { id: duplicateId } }),
  ]);
  if (!primary || !duplicate) {
    return res.status(404).json({ error: "Клиент не найден" });
  }
  if (primaryId === duplicateId) {
    return res.status(400).json({ error: "Нельзя объединить карточку саму с собой" });
  }
  // Сервер обязан сам убедиться, что это действительно один человек: раньше в merge
  // принималась ЛЮБАЯ пара id, то есть операция работала как «перенести сделки и
  // переписку чужого клиента на другого и удалить карточку». Критерий тот же, что у
  // GET /duplicates — совпадение телефона (последние 9 цифр) или Telegram-аккаунта.
  const samePhone = normalizePhone(primary.phone).slice(-9) === normalizePhone(duplicate.phone).slice(-9);
  const sameTelegram =
    (!!primary.telegramChatId && primary.telegramChatId === duplicate.telegramChatId) ||
    (!!primary.telegramUsername &&
      primary.telegramUsername.trim().toLowerCase() === duplicate.telegramUsername?.trim().toLowerCase());
  // force — ручное подтверждение с карточки клиента (владелец 19.08.2026, живой
  // случай: клиент писал с одного номера, позвонил с другого — карточки на разные
  // номера, но человек тот же). Автоматика такое не распознает и не должна: имя,
  // как правило, тоже разное («Клиент Instagram» vs «Входящий +992…»). Решает
  // агент, глядя на обе карточки, а не совпадение полей.
  if (!samePhone && !sameTelegram && !force) {
    return res.status(409).json({
      error: "Это разные люди: телефон и Telegram-аккаунт не совпадают. Объединять можно только дубликаты одного контакта",
    });
  }

  // Ядро переноса (хронология, звонки, показы, номера, дозаполнение полей,
  // мягкое удаление дубликата) — общее с routes/clients/duplicateReviews.ts
  // (агент подтвердил «это мой клиент»), см. lib/clientMerge.ts.
  let merged;
  try {
    merged = await mergeClients(
      primaryId,
      duplicateId,
      req.agent!.id,
      `Объединение дубликатов: «${duplicate.fullName}» (${duplicate.phone}) влит в эту карточку`
    );
  } catch (err) {
    // Одна из карточек в Корзине или склейка уже выполнена (повторный клик) — B2, 02.10.2026.
    if (err instanceof ClientMergeTrashedError) return res.status(409).json({ error: err.message });
    // У дубля идёт сделка у другого агента — склейка ждёт её закрытия (решение владельца 02.10.2026).
    if (err instanceof ClientMergeOpenDealError) return res.status(409).json({ error: err.message });
    // Карточка могла исчезнуть (гонка с удалением) между проверкой выше и слиянием —
    // раньше это молча уходило в ответ как `null`, и фронтенд падал на чтении полей.
    return res.status(404).json({ error: err instanceof Error ? err.message : "Клиент не найден" });
  }

  // Требования/просьбы о звонке дубликата и его заявка на удаление гасятся
  // теперь внутри самого mergeClients (11.09.2026, второй заход по осиротевшим
  // спутникам) — так же получает гашение и confirmDuplicateReview
  // (lib/duplicateReview.ts), который зовёт mergeClients напрямую, минуя этот
  // роут. Копия здесь однажды разошлась бы с той веткой (ровно так и вышло).

  // Слияние необратимо переносит сделки и переписку — в Журнале действий не
  // оставалось ни строки о том, кто и что с чем объединил.
  logAudit(req, "CLIENT_MERGE", "Client", primaryId, {
    primaryShortId: primary.shortId,
    duplicateId,
    duplicateShortId: duplicate.shortId,
    duplicateName: duplicate.fullName,
    duplicatePhone: duplicate.phone,
    matchedBy: samePhone ? "phone" : sameTelegram ? "telegram" : "manual",
  });
  void closeSimilarClientsAlert(primaryId, duplicateId).catch((err) =>
    console.error("[push] закрытие предупреждения о дубликате после слияния:", err)
  );

  // Карточка только что обновлена в транзакции выше, поэтому null здесь означает
  // гонку с удалением. Раньше он молча уходил в ответ как `null`, и фронтенд падал
  // на чтении полей — лучше честный 404.
  if (!merged) {
    return res.status(404).json({ error: "Клиент не найден" });
  }
  // Просьбы о звонке дубликата уже погашены выше, внутри closeClientSatellites —
  // отдельный вызов здесь был бы вторым, ничего не меняющим (updateMany по
  // doneAt: null идемпотентен), но лишним походом в базу.
  res.json(presentClient(merged, can(req, "clients.viewPhone"), can(req, "clients.viewOrigin")));
});
