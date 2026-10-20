/**
 * Г3 (docs/architecture-blueprint.md §1.3, §3): бывший routes/properties.ts (2999
 * строк, 39 роутов) распилен на группы по сюжетам. Сборка групп в один роутер —
 * здесь; сами роуты перенесены verbatim.
 *
 * ⚠️ ПОРЯДОК ПОДКЛЮЧЕНИЯ — ЧАСТЬ ПОВЕДЕНИЯ (правило чертежа №8, «порядок
 * регистрации — фиксировать комментарием»): статичные пути GET /export и
 * GET /trash обязаны матчиться ДО GET /:id — все четыре живут в list.ts в том же
 * порядке, что и в исходном файле, поэтому list подключается ПЕРВЫМ. Перестановка
 * молча превратила бы их в «объект с shortId=trash» (Express берёт первый
 * подходящий маршрут; GET /:id, правда, ещё и требует числовой shortId — но
 * полагаться на это нельзя).
 *
 * Второй чувствительный случай — DELETE /share-links/:linkId (shareLinks.ts) и
 * DELETE /:id/permanent (crud.ts): оба двухсегментные, и путь
 * /share-links/permanent подходит обоим. В исходном файле /:id/permanent объявлен
 * раньше — поэтому crud подключается ДО shareLinks, поведение сохранено
 * (id="share-links" не находится в Корзине → 404, как и раньше).
 *
 * Остальные группы пересечений путей не имеют: их роуты различаются HTTP-методом,
 * числом сегментов или статичным вторым сегментом (/:id/photos vs /:id/videos vs
 * /:id/share-links vs /:id/review/... vs /bulk-sync и т.п.). В исходном файле
 * блок share-links стоял МЕЖДУ clip-video и остальными видео-маршрутами, а
 * DELETE-трио crud (/:id, restore, permanent) — ПОСЛЕ блока модерации; обе группы
 * здесь собраны целиком, что меняет взаимный порядок регистрации, но не матчинг —
 * пересечений между переставленными путями нет ни одного (проверено по методам и
 * сегментам при распиле). Порядок ниже сохранён близким к исходному файлу.
 *
 * Четвёртый случай (03.09.2026): POST /bulk-trash в crud.ts — односегментный
 * статичный путь. Пересечений у него нет (POST /:id в проекте не объявлен нигде),
 * но при добавлении такого маршрута порядок придётся пересмотреть.
 *
 * Третий случай, добавленный 31.08.2026: deleteRequests.ts тоже даёт статичный
 * `GET /delete-requests` — тем же способом, что и в routes/clients/index.ts, он
 * обязан подключаться ДО listRouter (GET /:id), иначе Express примет
 * id="delete-requests" и всегда ответит 404.
 *
 * Пятый случай (10.09.2026, шаг 5 переноса): summary.ts даёт статичный
 * `GET /summary` — тем же способом, что и /clients/summary. Подключается ДО
 * listRouter по той же причине: иначе "summary" ушёл бы в GET /:id и получил
 * 404 (там shortId обязан быть числом).
 *
 * Седьмой случай (12.09.2026, блок N плана): map.ts даёт статичный `GET /map`
 * — той же причиной и тем же лекарством, подключается ДО listRouter.
 *
 * Шестой случай (11.09.2026): drafts.ts даёт статичную ветку `/drafts/...` —
 * включая `POST /drafts/current/photos`, трёхсегментный путь, который иначе
 * подошёл бы под `POST /:id/photos` (photos.ts) с id="drafts". Подключается
 * ПЕРВЫМ — раньше и listRouter (GET /:id), и photosRouter.
 */
import { Router } from "express";
import { draftsRouter } from "./drafts.js";
import { listRouter } from "./list.js";
import { propertiesSummaryRouter } from "./summary.js";
import { propertiesMapRouter } from "./map.js";
import { deleteRequestsRouter } from "./deleteRequests.js";
import { changeRequestsRouter } from "./changeRequests.js";
import { crudRouter } from "./crud.js";
import { moderationRouter } from "./moderation.js";
import { photosRouter } from "./photos.js";
import { videosRouter } from "./videos.js";
import { shareLinksRouter } from "./shareLinks.js";
import { ownerReportLinkRouter } from "./ownerReportLink.js";
import { smsShareRouter } from "./smsShare.js";
import { groupShareRouter } from "./groupShare.js";
import { matchingRouter } from "./matching.js";
import { propertyDuplicateCheckRouter } from "./duplicateCheck.js";
import { propertyTransferRouter } from "./transfer.js";
import { propertiesHealthRouter, statsRouter } from "./stats.js";

export const propertiesRouter = Router();

// НЕ МЕНЯТЬ ПОРЯДОК: статичные GET-пути (/delete-requests, /summary, /map,
// /duplicate-check здесь, /export и /trash в list) — до GET /:id; crud
// (DELETE /:id/permanent) — до shareLinks (DELETE /share-links/:linkId); drafts
// (/drafts/current/photos) — до photos (/:id/photos).
//
// Восьмой случай (15.09.2026): duplicateCheck.ts даёт статичный `GET
// /duplicate-check` — той же причиной, что и /summary, /map — подключается ДО
// listRouter, иначе Express принял бы "duplicate-check" за shortId в GET /:id.
propertiesRouter.use(draftsRouter);
propertiesRouter.use(deleteRequestsRouter);
// Заявки на изменение опубликованного объекта (07.10.2026): статичный `GET /change-requests` — тоже ДО listRouter.
propertiesRouter.use(changeRequestsRouter);
propertiesRouter.use(propertiesSummaryRouter);
propertiesRouter.use(propertiesMapRouter);
propertiesRouter.use(propertyDuplicateCheckRouter);
// Девятый случай (24.09.2026): transfer.ts даёт статичный `GET /handover/pending`
// — та же причина, подключается ДО listRouter.
propertiesRouter.use(propertyTransferRouter);
// «health» и «needs-help» — одно слово в пути, тоже ДО listRouter (GET /:id).
propertiesRouter.use(propertiesHealthRouter);
propertiesRouter.use(listRouter);
propertiesRouter.use(crudRouter);
propertiesRouter.use(moderationRouter);
propertiesRouter.use(photosRouter);
propertiesRouter.use(videosRouter);
propertiesRouter.use(statsRouter);
propertiesRouter.use(shareLinksRouter);
propertiesRouter.use(ownerReportLinkRouter);
propertiesRouter.use(smsShareRouter);
propertiesRouter.use(groupShareRouter);
propertiesRouter.use(matchingRouter);
