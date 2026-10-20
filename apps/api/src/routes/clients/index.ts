/**
 * Г2 (docs/architecture-blueprint.md §1.2, §3): бывший routes/clients.ts (3093
 * строки, 33 роута) распилен на группы по сюжетам. Сборка групп в один роутер —
 * здесь; сами роуты перенесены verbatim.
 *
 * ⚠️ ПОРЯДОК ПОДКЛЮЧЕНИЯ — ЧАСТЬ ПОВЕДЕНИЯ (правило чертежа №8, «порядок
 * регистрации — фиксировать комментарием»): статичные пути GET /duplicates,
 * GET /trash и GET /lost обязаны матчиться ДО GET /:id (card.ts) — как и в
 * исходном файле, где они объявлены выше. Перестановка молча превратит их в
 * «клиента с id=trash» (Express возьмёт первый подходящий маршрут). Поэтому
 * list и duplicates подключаются ПЕРВЫМИ, card — строго после них.
 *
 * Остальные группы конфликтов путей не имеют: их роуты различаются HTTP-методом
 * или статичным вторым сегментом (`/:id/accept` vs `/:id/message` и т.п.), а
 * одиночные статичные POST (`/merge`, `/dial`) не перекрываются ни с `POST /`,
 * ни с каким-либо `POST /:id` (такого роута нет). Порядок ниже сохранён близким
 * к исходному файлу.
 */
import { Router } from "express";
import { listRouter } from "./list.js";
import { summaryRouter } from "./summary.js";
import { duplicatesRouter } from "./duplicates.js";
import { deleteRequestsRouter } from "./deleteRequests.js";
import { propertyCountDisputesRouter } from "./propertyCountDisputes.js";
import { reactivationOffersRouter } from "./reactivationOffers.js";
import { duplicateReviewsRouter } from "./duplicateReviews.js";
import { cardRouter } from "./card.js";
import { lifecycleRouter } from "./lifecycle.js";
import { interactionsRouter } from "./interactions.js";
import { suggestionsRouter } from "./suggestions.js";
import { communicationsRouter } from "./communications.js";
import { whatsappFirstContactRouter } from "./whatsappFirstContact.js";
import { matchingRouter } from "./matching.js";
import { sellerObjectRouter } from "./sellerObject.js";
import { propertyActivityRouter } from "./propertyActivity.js";

export const clientsRouter = Router();

// НЕ МЕНЯТЬ ПОРЯДОК: статичные GET-пути (list, duplicates, delete-requests,
// property-count-disputes, reactivation-offers) — до GET /:id (card). У очередей
// заявок статичные пути `GET /delete-requests`, `GET /property-count-disputes`
// и `GET /reactivation-offers`: за cardRouter они превратились бы в «клиента с
// id=delete-requests»/«id=property-count-disputes»/«id=reactivation-offers» и
// всегда отвечали бы 404.
clientsRouter.use(listRouter);
// /summary — до cardRouter (GET /:id), как /trash и /lost.
clientsRouter.use(summaryRouter);
clientsRouter.use(duplicatesRouter);
clientsRouter.use(deleteRequestsRouter);
clientsRouter.use(propertyCountDisputesRouter);
clientsRouter.use(reactivationOffersRouter);
// GET /duplicate-reviews — тот же статичный-путь-до-card довод, что у /reactivation-offers.
clientsRouter.use(duplicateReviewsRouter);
clientsRouter.use(cardRouter);
clientsRouter.use(lifecycleRouter);
clientsRouter.use(interactionsRouter);
clientsRouter.use(suggestionsRouter);
clientsRouter.use(communicationsRouter);
clientsRouter.use(whatsappFirstContactRouter);
clientsRouter.use(matchingRouter);
// GET /:id/seller-object — статичный второй сегмент, с GET /:id не пересекается.
clientsRouter.use(sellerObjectRouter);
clientsRouter.use(propertyActivityRouter);
