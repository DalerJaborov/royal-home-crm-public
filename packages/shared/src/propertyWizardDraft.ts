import { z } from "zod";

/**
 * ЧЕРНОВИК МАСТЕРА ДОБАВЛЕНИЯ ОБЪЕКТА (11.09.2026, просьба владельца «черновик
 * сделай») — общая форма снимка полей для сервера и вкладки.
 *
 * Не путать с `propertyDraft.ts`: там предложение ИИ по словам продавца, оно
 * ничего не хранит. Здесь — то, что агент реально набрал и что обязано пережить
 * закрытие приложения и смену устройства.
 *
 * ПОЧЕМУ ВСЁ ПОЛЕ — СТРОКА, И ЧИСЛА НЕ ПРИВОДЯТСЯ ЗДЕСЬ. Черновик обязан уметь
 * хранить наполовину набранное: агент стирает «85» до «8», и в этот момент
 * площадь не число. Приведение к числу происходит ровно один раз, в момент
 * отправки POST /properties (`buildCreateBody` на вкладке, `propertyCreateSchema`
 * на сервере) — второй точки приведения быть не должно, иначе они разойдутся.
 *
 * ПОЧЕМУ ВСЕ ПОЛЯ НЕОБЯЗАТЕЛЬНЫ. Черновик, записанный сборкой прошлой недели, не
 * знает полей, добавленных сегодня, — и наоборот. Строгая схема превратила бы
 * каждое обновление приложения в потерю чужого черновика; вкладка раскладывает
 * присланное поверх пустого набора и берёт только знакомое.
 */

/** Сколько дней живёт брошенный черновик. Недельной давности — это уже не та
 *  квартира и не тот разговор; подставлять его вреднее, чем пустая форма. */
export const PROPERTY_DRAFT_TTL_DAYS = 7;

/** Шагов в мастере — потолок для сохраняемого номера шага. */
export const PROPERTY_WIZARD_STEP_COUNT = 5;

/** Потолок длины текстового поля черновика — защита от записи мегабайта в JSONB. */
const draftText = (max: number) => z.string().max(max);

export const propertyWizardDraftValuesSchema = z
  .object({
    type: draftText(32),
    rooms: draftText(16),
    areaSqm: draftText(16),
    landAreaSotka: draftText(16),
    floor: draftText(16),
    totalFloors: draftText(16),
    windowCount: draftText(16),
    price: draftText(24),
    currency: draftText(8),
    condition: draftText(32),
    marketType: draftText(32),
    districtId: draftText(64),
    address: draftText(500),
    /** Ориентир — свободный текст, тот же потолок 120, что и у propertyCreateSchema. */
    landmark: draftText(120),
    lat: z.number().min(-90).max(90).nullable(),
    lng: z.number().min(-180).max(180).nullable(),
    sellerClientId: draftText(64),
    sellerName: draftText(120),
    sellerPhone: draftText(32),
    intakeAgentId: draftText(64),
    /** Режим «на сайт / только своим» (владелец 12.09.2026) — чип в шапке
     *  мастера, а не поле формы; переживает автосохранение черновика так же,
     *  как и остальные значения. */
    offSite: z.boolean(),
    /**
     * ХАРАКТЕРИСТИКИ, ДОКУМЕНТЫ И СТАДИЯ СТРОЙКИ — ЧЕТЫРЕ ЗАБЫТЫХ ПОЛЯ
     * (найдено 21.09.2026, живая жалоба владельца про черновик).
     *
     * Эти поля есть в `WizardValues` с 15.09.2026, но в схему их не дописали.
     * zod у обычного `z.object` лишние ключи не отвергает, а МОЛЧА СРЕЗАЕТ —
     * поэтому автосохранение отвечало успехом, строка «Черновик сохранён»
     * загоралась, а 13 характеристик, документы и стадия в черновик не
     * попадали вовсе. Агент возвращался к черновику и видел эту часть формы
     * пустой, без единого признака, что что-то потерялось.
     *
     * ЛЕНИВЫЕ ТИПЫ, А НЕ `propertyDetailsSchema`. Строгая схема характеристик
     * принимает только готовые значения из `PROPERTY_DETAIL_OPTIONS`, а мастер
     * держит в этих полях ещё и «не указано» (`DETAIL_NOT_SET`) — то самое
     * наполовину набранное, ради которого весь черновик и строками. Ключи тоже
     * не перечисляем: черновик прошлой сборки не знает характеристику,
     * добавленную сегодня, и наоборот (см. заголовок файла).
     */
    details: z
      .record(z.string().max(64), z.string().max(64))
      // Потолок на число ключей — тот же довод, что и у `draftText`: защита от
      // записи мегабайта в JSONB. Характеристик 13, запас взят с лихвой.
      .refine((v) => Object.keys(v).length <= 40, { message: "Слишком много характеристик" }),
    /** Пресет «Документов» — своей строкой, как в мастере; `"Другое"` тоже. */
    documentsPreset: draftText(64),
    /** Своя строка «Документов». 200 — тот же предел, что у `documents` в
     *  propertyCreateSchema: черновик не должен принимать больше, чем потом
     *  возьмёт создание объекта. */
    documentsOther: draftText(200),
    /** Стадия стройки — только у новостройки. */
    stage: draftText(32),
  })
  .partial();

export type PropertyWizardDraftValues = z.infer<typeof propertyWizardDraftValuesSchema>;

/** Тело PUT /properties/drafts/current. */
export const propertyDraftSaveSchema = z.object({
  values: propertyWizardDraftValuesSchema,
  step: z.number().int().min(0).max(PROPERTY_WIZARD_STEP_COUNT - 1),
});

/** Тело POST /properties/drafts/current/videos/sessions. */
export const propertyDraftVideoSessionSchema = z.object({
  uploadKey: z.string().min(8).max(128),
  filename: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
  contentType: z.string().min(1).max(128),
});

export interface PropertyDraftMediaView {
  id: string;
  kind: "PHOTO" | "VIDEO";
  status: "UPLOADING" | "READY";
  uploadKey: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  order: number;
  /** Только у снимков: готовые пути для показа плиткой (у роликов null — сырое
   *  видео лежит в закрытом хранилище и превью у него нет). */
  url: string | null;
  thumbUrl: string | null;
}

export interface PropertyDraftView {
  id: string;
  values: PropertyWizardDraftValues;
  step: number;
  updatedAt: string;
  expiresAt: string;
  media: PropertyDraftMediaView[];
}
