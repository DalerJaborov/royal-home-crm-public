import { z } from "zod";
import { prisma } from "../db.js";
import { geocodeAddress } from "../lib/geocode.js";
import { logSystemError } from "../lib/systemError.js";
import { districtByPoint } from "../lib/propertyDistrict.js";
import { buildPropertyTitle } from "@royal-home/shared";
import type { JobHandler } from "./registry.js";

/**
 * Координаты объекта по адресу — ПИЛОТНЫЙ джоб очереди (чертёж §2.3, №6).
 *
 * Раньше — fire-and-forget прямо в HTTP-процессе (routes/properties.ts,
 * geocodeInBackground) без единого ретрая: Nominatim моргнул — объект навсегда
 * без точки на карте, и никто об этом не знал. Теперь постановка переживает
 * деплой, а провал ретраится и в конце концов честно попадает в журнал.
 *
 * Идемпотентность: повторный run просто пересчитает те же координаты — запись
 * lat/lng одинакова, удалённый объект пропускается updateMany-условием.
 *
 * АДРЕС БЕРЁТСЯ ИЗ БАЗЫ, А НЕ ИЗ ЗАДАНИЯ (24.09.2026). Ключ `geocode:{id}` занят,
 * пока задание ждёт, исполняется или идёт по лесенке повторов (jobs/enqueue.ts),
 * и вторая постановка в это время — пустая операция. Агент поправил адрес через
 * минуту после первого — задание просыпалось и честно геокодировало СТАРЫЙ адрес
 * из своего payload: точка вставала туда, откуда объект уже «переехал». Теперь
 * payload несёт только propertyId (address/districtName остались необязательными
 * ради строк, поставленных до правки, и скрипта scripts/geocode-coverage.ts), а
 * адрес и район читаются в момент исполнения.
 */
const schema = z.object({
  propertyId: z.string(),
  address: z.string().nullish(),
  districtName: z.string().nullish(),
});

/** Предел попыток — его передаёт постановщик (routes/properties.ts): см.
 *  докстринг enqueue.ts, почему не в обработчике. */
export const GEOCODE_MAX_ATTEMPTS = 5;

export const geocodeJob: JobHandler<z.infer<typeof schema>> = {
  type: "geocode",
  schema,
  // Nominatim бесплатный и капризный: щадящая лесенка 2м → 8м → 18м → 32м.
  backoff: (attempt) => attempt * attempt * 2 * 60_000,
  async run(payload) {
    const property = await prisma.property.findUnique({
      where: { id: payload.propertyId },
      select: {
        address: true,
        deletedAt: true,
        lat: true,
        geocodedAt: true,
        districtId: true,
        shortId: true,
        title: true,
        type: true,
        rooms: true,
        district: { select: { name: true } },
      },
    });
    // Объект удалён — геокодировать нечего. Точку поставил человек (координаты
    // есть, отметки автогеокодера нет) — её не трогаем и Nominatim не спрашиваем.
    if (!property || property.deletedAt) return;
    if (property.lat != null && property.geocodedAt == null) return;
    const address = property.address?.trim();
    if (!address) return;

    const result = await geocodeAddress(address, property.district?.name ?? "");
    // «Адрес не нашёлся» — не ошибка, а ответ: ретраить бессмысленно, точку
    // поставит человек. Ошибкой (и поводом для ретрая) остаётся только отказ сети.
    // Но и не молчание (24.09.2026): объект остаётся без точки на карте, и
    // журнал — единственное место, где это видно. Запись одна на задание:
    // сюда попадаем только по успешному ответу провайдера, повтор не идёт.
    if (!result) {
      await logSystemError(
        "geocode",
        `Адрес объекта №${property.shortId} не найден ни в справочнике домов, ни в Nominatim — ` +
          `точку на карте нужно поставить руками (адрес: ${address.slice(0, 120)})`
      );
      return;
    }
    const written = await prisma.property.updateMany({
      // Ручной пин в приоритете (аудит №4): агент мог поставить точку на карте,
      // пока задание ждало бэкофф. У ручных координат geocodedAt пуст — их не
      // трогаем; обновляем только пустые координаты или прошлый результат
      // самого геокодера.
      //
      // До 12.09.2026 защита не работала: routes/properties/crud.ts на ручной пин
      // СТАВИЛ geocodedAt, и условие ниже разрешало затереть точку человека. Теперь
      // отметка значит ровно «координаты поставил автогеокодер», ручной пин и
      // координаты с сайта её гасят. Инвариант держит tests/geocode-manual-pin.test.ts —
      // менять смысл поля в одном месте, не тронув остальные, он больше не даст.
      //
      // address — тот, что мы геокодировали: если агент поменял его, пока шёл
      // запрос, точка старого адреса не записывается (см. проверку ниже).
      where: {
        id: payload.propertyId,
        deletedAt: null,
        address: property.address,
        OR: [{ lat: null }, { geocodedAt: { not: null } }],
      },
      data: { lat: result.lat, lng: result.lng, geocodedAt: new Date() },
    });
    if (written.count === 0) {
      // Адрес сменился прямо во время запроса: вторая постановка ключом отбита
      // (задание исполнялось), значит новый адрес — забота этого же задания.
      // Бросаем — очередь повторит через бэкофф и прочтёт уже новый адрес.
      const now = await prisma.property.findUnique({
        where: { id: payload.propertyId },
        select: { address: true, deletedAt: true },
      });
      if (now && !now.deletedAt && now.address !== property.address) {
        throw new Error(`Адрес объекта ${payload.propertyId} сменился во время геокодирования — повтор по новому`);
      }
      return;
    }
    // Район по новой точке — ТОЛЬКО в пустое поле (24.09.2026): выбранный агентом
    // район автогеокодер не переписывает — точка по строке адреса догадка, а не
    // факт, которым lib/propertyDistrict.ts разрешает перебить выбор человека.
    if (!property.districtId) {
      const district = await districtByPoint(result.lat, result.lng);
      if (district) {
        // Название ведёт сервер («3-комн · Сино», crud.ts пересобирает его на
        // каждой правке), и без района оно было просто «3-комн». Район пришёл —
        // название догоняет (25.09.2026). Только если оно всё ещё то самое
        // автоматическое без района: название из импорта не трогаем.
        const titleWithoutDistrict = buildPropertyTitle({ type: property.type, rooms: property.rooms });
        const retitle = property.title === titleWithoutDistrict;
        // Район и название посчитаны по снимку, прочитанному до запроса к Nominatim
        // (секунды), а запись шла только по id и пустому району (CHANNEL-NEW-04): пока
        // шёл запрос, пользователь мог сменить адрес, тип, комнаты или название, и старый
        // снимок затирал новое. Условие теперь включает всё, из чего считано.
        const written = await prisma.property.updateMany({
          where: {
            id: payload.propertyId,
            districtId: null,
            address: property.address,
            type: property.type,
            rooms: property.rooms,
            title: property.title,
          },
          data: {
            districtId: district.id,
            ...(retitle
              ? { title: buildPropertyTitle({ type: property.type, rooms: property.rooms, districtName: district.name }) }
              : {}),
          },
        });
        if (written.count === 0) {
          // Поменялись тип, комнаты или название: название не трогаем (сервер пересоберёт
          // его при правке), но район зависит только от адреса, и его ставим, если адрес
          // тот же, по которому найдена точка.
          await prisma.property.updateMany({
            where: { id: payload.propertyId, districtId: null, address: property.address },
            data: { districtId: district.id },
          });
        }
      }
    }
  },
  async onGiveUp(payload) {
    const property = await prisma.property.findUnique({ where: { id: payload.propertyId }, select: { address: true } });
    const address = property?.address ?? payload.address ?? "";
    await logSystemError(
      "geocode",
      `Координаты объекта ${payload.propertyId} не получены после всех попыток (адрес: ${address.slice(0, 120)})`
    );
  },
};
