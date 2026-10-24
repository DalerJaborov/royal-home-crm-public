import { Router } from "express";
import multer from "multer";
import type { ZodIssue, z } from "zod";
import {
  clientCreateSchema,
  propertyCreateSchema,
  CLIENT_SOURCE_LABELS,
  PROPERTY_TYPE_LABELS,
  PROPERTY_CONDITION_LABELS,
  CLIENT_SOURCES,
  PROPERTY_TYPES,
  PROPERTY_CONDITIONS,
  buildPropertyTitle,
} from "@royal-home/shared";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { csvToRecords } from "../lib/csv.js";
import { findDistrictIdByName } from "../lib/districtLookup.js";
import { normalizePropertyAddress } from "./properties/shared.js";
import { loadStaffPhoneChecker, staffPhoneError } from "../lib/staffPhoneGuard.js";
import { logSystemError } from "../lib/systemError.js";
import { findPhoneOwners, phoneTail } from "../lib/clientPhones.js";
import { SELF_CREATED_ASSIGN_REASON } from "../services/leads/firstCall.js";

/**
 * CSV из Excel часто сохранён в Windows-1251, а не в UTF-8: при слепом
 * toString("utf-8") кириллица превращалась в U+FFFD, ни один заголовок не
 * совпадал, и все 2000 строк отбрасывались с невнятным «заполните поле»
 * (26.08.2026). Признак — символы замены в декодированном тексте; тогда
 * пробуем windows-1251 (TextDecoder с полным ICU есть в Node 24).
 */
function decodeCsvBuffer(buffer: Buffer): string {
  const utf8 = buffer.toString("utf-8");
  if (!utf8.includes("�")) return utf8;
  try {
    return new TextDecoder("windows-1251").decode(buffer);
  } catch {
    return utf8;
  }
}

export const importRouter = Router();

// Массовый импорт — операция администратора при внедрении CRM в агентстве.
importRouter.use(requireAuth, requirePermission("import.run"));

// files: 1 обязателен рядом с fileSize: без него multer принимает НЕОГРАНИЧЕННОЕ
// число файлов по 5 МБ каждый — предел на файл превращается в отсутствие предела
// на запрос, а хранилище здесь memoryStorage (аудит лимитов 21.08.2026).
// Импорт всегда одним файлом: разбор ниже читает req.file, не req.files.
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
});

/** Русская подпись или enum-значение → enum. "Instagram" и "INSTAGRAM" равно валидны. */
function toEnum<T extends string>(value: string, values: readonly T[], labels: Record<T, string>): T | null {
  const v = value.trim();
  if (!v) return null;
  const direct = values.find((x) => x.toLowerCase() === v.toLowerCase());
  if (direct) return direct;
  const byLabel = values.find((x) => labels[x].toLowerCase() === v.toLowerCase());
  return byLabel ?? null;
}

function toNumber(value: string): number | undefined {
  const n = Number(value.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) && value.trim() !== "" ? n : undefined;
}

/** Названия колонок шаблона (не имена полей схемы) — ошибки должны указывать на то,
 * что человек реально видит в своём Excel-файле, а не на технические имена схемы. */
const CLIENT_COLUMN_LABELS: Record<string, string> = {
  fullName: "Имя",
  phone: "Телефон",
  email: "Email",
  source: "Источник",
  budgetMin: "Бюджет от",
  budgetMax: "Бюджет до",
  desiredRooms: "Комнаты",
  requirementsNotes: "Заметки",
};

const PROPERTY_COLUMN_LABELS: Record<string, string> = {
  title: "Название",
  type: "Тип",
  rooms: "Комнаты",
  areaSqm: "Площадь",
  floor: "Этаж",
  totalFloors: "Этажей всего",
  windowCount: "Окна",
  price: "Цена",
  currency: "Валюта",
  address: "Адрес",
  condition: "Состояние",
  description: "Описание",
  ownerContact: "Контакт владельца",
};

/** Обычный zod-issue ("Expected number, received nan") нечитаем для нетехнического
 * пользователя, заполняющего Excel-шаблон. Переводим в понятную фразу на русском,
 * привязанную к названию колонки, а не к внутреннему имени поля схемы. */
function friendlyIssue(issue: ZodIssue, columnLabels: Record<string, string>): string {
  const field = String(issue.path[0] ?? "");
  const column = columnLabels[field] ?? field;
  switch (issue.code) {
    // zod 4: у issue больше нет строкового `received` — есть само значение `input`;
    // `too_small.type` переименован в `origin`; `invalid_enum_value` слился с
    // `invalid_value`, а `invalid_string` — с `invalid_format`.
    case "invalid_type":
      if (issue.input === undefined || (typeof issue.input === "number" && Number.isNaN(issue.input))) {
        return `«${column}» — заполните это поле`;
      }
      return `«${column}» — неверный формат (ожидалось: ${issue.expected === "number" ? "число" : issue.expected})`;
    case "too_small":
      return issue.origin === "string"
        ? `«${column}» — слишком короткое значение или пусто`
        : `«${column}» — значение слишком маленькое`;
    case "invalid_value":
      return `«${column}» — неизвестное значение «${String(issue.input)}», проверьте написание (можно как в шаблоне, так и точным словом из списка)`;
    case "invalid_format":
      return `«${column}» — неверный формат`;
    default:
      return `«${column}» — ${issue.message}`;
  }
}

function friendlyIssues(issues: ZodIssue[], columnLabels: Record<string, string>): string {
  return issues.map((i) => friendlyIssue(i, columnLabels)).join("; ");
}

/** Шаблоны для заполнения — скачиваются из Настроек, открываются в Excel. */
importRouter.get("/clients/template", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=clients-template.csv");
  res.send("﻿Имя;Телефон;Email;Источник;Бюджет от;Бюджет до;Комнаты;Заметки\nУмед Собиров;+992901234567;;Instagram;300000;450000;2;Ищет квартиру в Сино\n");
});

importRouter.get("/properties/template", (_req, res) => {
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=properties-template.csv");
  res.send("﻿Название;Тип;Комнаты;Площадь;Этаж;Этажей всего;Окна;Цена;Валюта;Район;Адрес;Состояние;Описание;Контакт владельца\n2-комн · Сино;Квартира;2;54;3;9;4;350000;TJS;Сино;ул. Айни, 10;Хорошее;;+992900000099\n");
});

/**
 * POST /import/clients — CSV с заголовками (Имя;Телефон;Email;Источник;Бюджет от;
 * Бюджет до;Комнаты;Заметки). Каждая строка валидируется Zod; дубликаты по телефону
 * пропускаются с пояснением. Ответ: created + список пропусков по строкам.
 */
importRouter.post("/clients", csvUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });
  const { records } = csvToRecords(decodeCsvBuffer(req.file.buffer));
  if (records.length === 0) return res.status(400).json({ error: "Файл пуст или без строк данных" });
  if (records.length > 2000) return res.status(400).json({ error: "Максимум 2000 строк за один импорт" });

  const importerId = req.agent!.id;
  let created = 0;
  const skipped: { row: number; error: string }[] = [];

  // Сначала разбираем весь файл, потом одним запросом узнаём занятые телефоны.
  // Раньше на каждую строку шёл отдельный findUnique: 2000 строк = 2000 запросов
  // подряд ещё до единой записи. Импорт базы упирался в это, а не в диск.
  // desiredPlaces — не скаляр (см. routes/clients/card.ts): импорт из CSV его не
  // заполняет, а плоский тип поля не совпадает с ожидаемым Prisma вложенным
  // create — исключаем из типа строки, как force/assignedAgentId.
  type ClientRow = Omit<z.infer<typeof clientCreateSchema>, "force" | "assignedAgentId" | "desiredPlaces">;
  const ready: { rowNum: number; data: ClientRow }[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const rowNum = i + 2; // человекочитаемый номер строки в файле (с учётом заголовка)
    const source = toEnum(r["источник"] ?? "", CLIENT_SOURCES, CLIENT_SOURCE_LABELS) ?? "WALK_IN";
    const candidate = {
      fullName: r["имя"] ?? "",
      phone: (r["телефон"] ?? "").replace(/\s/g, ""),
      email: r["email"] || undefined,
      source,
      budgetMin: toNumber(r["бюджет от"] ?? ""),
      budgetMax: toNumber(r["бюджет до"] ?? ""),
      desiredRooms: toNumber(r["комнаты"] ?? ""),
      requirementsNotes: r["заметки"] || undefined,
    };
    const parsed = clientCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped.push({ row: rowNum, error: friendlyIssues(parsed.error.issues, CLIENT_COLUMN_LABELS) });
      continue;
    }
    const { force: _force, assignedAgentId: _ignored, ...data } = parsed.data;
    ready.push({ rowNum, data });
  }

  /**
   * ДУБЛЬ — ПО ХВОСТУ НОМЕРА И ПО ВСЕМ НОМЕРАМ КАРТОЧКИ (B8, 02.10.2026). Раньше
   * сверялась только точная строка `phone`: тот же номер, записанный иначе
   * («901234567» против «+992901234567»), или номер, который у другой карточки
   * стоит запасным/WhatsApp, давал вторую карточку того же человека у импортёра.
   * Правило то же, что у заявок и ручного создания: последние 9 цифр
   * (lib/clientPhones.ts), один запрос на весь файл. Корзина тоже считается —
   * как и раньше при точном совпадении: такого клиента возвращают из Корзины,
   * а не заводят заново.
   */
  const owners = await findPhoneOwners(
    ready.map((r) => r.data.phone),
    { includeDeleted: true, limit: ready.length * 3 + 10 }
  );
  const taken = new Map<string, string>();
  for (const o of owners) {
    for (const p of [o.phone, o.whatsappPhone ?? "", ...(o.extraPhones ?? [])]) {
      const t = phoneTail(p);
      if (t && !taken.has(t)) taken.set(t, o.deletedAt ? `${o.fullName}» (в Корзине)` : `${o.fullName}»`);
    }
  }
  // Один запрос на весь файл (может быть 2000 строк), а не `await findStaffPhone`
  // на каждую — см. lib/staffPhoneGuard.ts.
  const staffPhone = await loadStaffPhoneChecker();

  // Отбор и внутрифайловая дедупликация телефонов — синхронно, в памяти (как и
  // раньше: `taken` заполняется по ходу, вторая строка с тем же телефоном в
  // одном файле ловится здесь же). Сама запись в базу теперь ОДНИМ `createMany`
  // на весь файл ниже (22.09.2026, сведение N+1) — было по одному `client.create`
  // на строку, до 2000 последовательных запросов на один импорт.
  const toInsert: { rowNum: number; data: ClientRow }[] = [];
  for (const { rowNum, data } of ready) {
    const owner = taken.get(phoneTail(data.phone));
    if (owner) {
      // Тот же телефон дважды внутри одного файла — тоже сюда: раньше вторая
      // строка доходила до базы, ловила нарушение уникальности и роняла ВЕСЬ
      // импорт пятисоткой. Уже созданные строки при этом оставались в базе, а
      // человек видел только ошибку и не знал, что импортировалось, а что нет.
      skipped.push({ row: rowNum, error: `Телефон ${data.phone} уже есть у «${owner}` });
      continue;
    }
    const staffMatch = staffPhone([data.phone]);
    if (staffMatch) {
      skipped.push({ row: rowNum, error: staffPhoneError(staffMatch) });
      continue;
    }
    taken.set(phoneTail(data.phone), `${data.fullName}» (строка ${rowNum} этого файла)`);
    toInsert.push({ rowNum, data });
  }

  if (toInsert.length > 0) {
    try {
      const result = await prisma.client.createMany({
        // Импортированные лиды числятся за импортёром и считаются принятыми:
        // это исторические клиенты, а не свежие заявки для автораспределения.
        // assignReason «завёл сам» (B3, 02.10.2026) — тот же щиток, что у клиента,
        // заведённого агентом на себя: окно «первый звонок за 15 минут» к переносу
        // базы не относится. Без него через 15 минут крон штрафовал импортёра по
        // каждой строке, писал «Первый звонок не совершён» в хронологию и будил
        // руководителей — сотни раз за один импорт.
        data: toInsert.map(({ data }) => ({
          ...data,
          assignedAgentId: importerId,
          acceptedAt: new Date(),
          assignReason: SELF_CREATED_ASSIGN_REASON,
        })),
      });
      created = result.count;
    } catch (err) {
      // Пачка целиком не легла (гонка с параллельным импортом/уникальный
      // индекс) — в отличие от одиночного create раньше, createMany не говорит,
      // какая именно строка не прошла, поэтому вся пачка уходит в skipped одной
      // общей причиной, а не 500-кой на весь запрос.
      const message = err instanceof Error ? err.message : "ошибка базы";
      for (const { rowNum } of toInsert) {
        skipped.push({ row: rowNum, error: `Не удалось сохранить: ${message}` });
      }
    }
  }

  res.json({ created, skipped });
});

/**
 * POST /import/properties — CSV (Название;Тип;Комнаты;Площадь;Этаж;Этажей всего;Цена;
 * Валюта;Район;Адрес;Состояние;Описание;Контакт владельца). Неизвестный район создаётся
 * автоматически — при переезде базы это ожидаемое поведение.
 */
importRouter.post("/properties", csvUpload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не передан" });
  const { records } = csvToRecords(decodeCsvBuffer(req.file.buffer));
  if (records.length === 0) return res.status(400).json({ error: "Файл пуст или без строк данных" });
  if (records.length > 2000) return res.status(400).json({ error: "Максимум 2000 строк за один импорт" });

  const importerId = req.agent!.id;
  let created = 0;
  const skipped: { row: number; error: string }[] = [];
  const districtCache = new Map<string, string>();
  // Собираем валидные строки здесь и пишем их ОДНИМ `createMany` после цикла
  // (22.09.2026, сведение N+1) — было по одному `property.create` на строку, до
  // 2000 последовательных запросов на один импорт. Кэш районов (districtCache)
  // не трогаем: он и так один запрос на РАЗЛИЧНОЕ имя района, а не на строку.
  const toInsert: { rowNum: number; data: Record<string, unknown> }[] = [];
  // Те же проверки, что и при создании объекта в карточке (находка №186): номер
  // сотрудника в «контакте владельца» не принимается. Один запрос на весь файл.
  const staffPhone = await loadStaffPhoneChecker();

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const rowNum = i + 2;

    const districtName = (r["район"] ?? "").trim();
    if (!districtName) {
      skipped.push({ row: rowNum, error: "Не указан район" });
      continue;
    }
    let districtId = districtCache.get(districtName.toLowerCase());
    if (!districtId) {
      // Сначала поиск БЕЗ учёта регистра: upsert по точному имени превращал
      // «Сино» и «сино» из одного файла в два разных района (26.08.2026).
      // Тем же правилом таджикское написание и латиница: «Шоҳмансур» в таблице —
      // это «Шохмансур», а не новый район (29.09.2026, lib/districtLookup.ts).
      districtId =
        (await findDistrictIdByName(districtName)) ??
        (
          await prisma.district.upsert({
            where: { name: districtName },
            update: {},
            create: { name: districtName },
          })
        ).id;
      districtCache.set(districtName.toLowerCase(), districtId);
    }

    const type = toEnum(r["тип"] ?? "", PROPERTY_TYPES, PROPERTY_TYPE_LABELS);
    const condition = toEnum(r["состояние"] ?? "", PROPERTY_CONDITIONS, PROPERTY_CONDITION_LABELS) ?? "GOOD";
    const currencyRaw = (r["валюта"] ?? "").trim().toUpperCase() || "TJS";
    const candidate = {
      title: r["название"] ?? "",
      type: type ?? undefined,
      rooms: toNumber(r["комнаты"] ?? ""),
      areaSqm: toNumber(r["площадь"] ?? ""),
      floor: toNumber(r["этаж"] ?? ""),
      totalFloors: toNumber(r["этажей всего"] ?? ""),
      // Окна обязательны у квартиры, дома и коммерции (схема объекта, этап 3),
      // а столбца под них в импорте не было — ни одна такая строка не проходила.
      windowCount: toNumber(r["окна"] ?? ""),
      price: toNumber(r["цена"] ?? ""),
      currency: currencyRaw,
      districtId,
      address: r["адрес"] ?? "",
      condition,
      amenities: [],
      description: r["описание"] || undefined,
      ownerContact: r["контакт владельца"] || undefined,
    };
    const parsed = propertyCreateSchema.safeParse(candidate);
    if (!parsed.success) {
      skipped.push({ row: rowNum, error: friendlyIssues(parsed.error.issues, PROPERTY_COLUMN_LABELS) });
      continue;
    }
    if (parsed.data.ownerContact?.trim()) {
      const staffMatch = staffPhone([parsed.data.ownerContact]);
      if (staffMatch) {
        skipped.push({ row: rowNum, error: staffPhoneError(staffMatch) });
        continue;
      }
    }
    const canonicalAddress = normalizePropertyAddress(parsed.data.address ?? "");
    toInsert.push({
      rowNum,
      data: {
        ...parsed.data,
        // Название из файла, если задано; иначе формируем автоматически (как в форме).
        title: parsed.data.title || buildPropertyTitle({ type: parsed.data.type, rooms: parsed.data.rooms, districtName }),
        // Канонный адрес — как при создании в карточке: по нему потом ищутся дубли.
        canonicalAddress,
        // Объект не выходит в продажу мимо проверки (находка №186). Статус тот же,
        // что у нового объекта из карточки: фото в файле нет, значит «Ждём фото»,
        // дальше — обычный конвейер (проверка маркетинга, видео, монтаж).
        status: "AWAITING_PHOTOS",
        // Риелтор при импорте не назначается (появится с первой сделкой);
        // импортёр фиксируется интейкером, чтобы объект был «его» в правах и 0.5%.
        intakeAgentId: parsed.data.intakeAgentId ?? importerId,
        createdById: importerId,
      },
    });
  }

  // ДУБЛИ ПО АДРЕСУ — тот же ключ, что в POST /properties: район + этаж +
  // нормализованный адрес + площадь с допуском ±2 м². Сверяем и с базой (один
  // запрос на весь файл), и строки файла между собой. Повторный запуск того же
  // файла теперь тоже ничего не задваивает.
  const AREA_TOLERANCE = 2;
  const DUP_SCAN_CAP = 20000;
  type Known = { area: number; label: string };
  const known = new Map<string, Known[]>();
  const keyOf = (districtId: unknown, floor: unknown, canonical: string) => `${districtId}|${floor ?? "null"}|${canonical}`;
  const importDistrictIds = [...new Set(toInsert.map(({ data }) => String(data.districtId)))];
  if (importDistrictIds.length > 0) {
    const stored = await prisma.property.findMany({
      where: { deletedAt: null, districtId: { in: importDistrictIds }, address: { not: null } },
      select: { shortId: true, districtId: true, floor: true, address: true, areaSqm: true },
      take: DUP_SCAN_CAP,
    });
    if (stored.length >= DUP_SCAN_CAP) {
      void logSystemError("api", `Импорт объектов: в базе больше ${DUP_SCAN_CAP} объектов этих районов — дубли проверены по первым ${DUP_SCAN_CAP}`);
    }
    for (const p of stored) {
      const key = keyOf(p.districtId, p.floor, normalizePropertyAddress(p.address ?? ""));
      const list = known.get(key) ?? [];
      list.push({ area: Number(p.areaSqm), label: `в базе, объект №${p.shortId}` });
      known.set(key, list);
    }
  }
  const uniqueRows: typeof toInsert = [];
  for (const row of toInsert) {
    const canonical = String(row.data.canonicalAddress ?? "");
    if (!canonical) {
      uniqueRows.push(row);
      continue;
    }
    const key = keyOf(row.data.districtId, row.data.floor, canonical);
    const area = Number(row.data.areaSqm);
    const dup = (known.get(key) ?? []).find((k) => Math.abs(k.area - area) <= AREA_TOLERANCE);
    if (dup) {
      skipped.push({ row: row.rowNum, error: `Такой объект уже есть (${dup.label})` });
      continue;
    }
    const list = known.get(key) ?? [];
    list.push({ area, label: `в этом файле, строка ${row.rowNum}` });
    known.set(key, list);
    uniqueRows.push(row);
  }
  toInsert.length = 0;
  toInsert.push(...uniqueRows);

  if (toInsert.length > 0) {
    try {
      const result = await prisma.property.createMany({
        data: toInsert.map(({ data }) => data) as Prisma.PropertyCreateManyInput[],
      });
      created = result.count;
    } catch (err) {
      // Пачка целиком не легла — как и у импорта клиентов выше, createMany не
      // говорит, какая именно строка виновата, поэтому вся пачка уходит в
      // skipped одной общей причиной вместо 500-ки на весь запрос. У объектов
      // нет уникального ключа, поэтому повторная загрузка того же файла и
      // прежде не защищала от дублей — поведение здесь не меняется.
      const message = err instanceof Error ? err.message : "ошибка базы";
      for (const { rowNum } of toInsert) {
        skipped.push({ row: rowNum, error: `Не удалось сохранить: ${message}` });
      }
    }
  }

  res.json({ created, skipped });
});
