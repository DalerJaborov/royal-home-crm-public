import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

/**
 * Хранилище документов сделки (Пачка 14, 11.09.2026): свидетельство собственности,
 * договор, паспорт, квитанция. Тот же принцип, что у lib/privateFiles.ts (закрытая
 * папка вне `uploads`, выдача только через авторизованный роут) — но НЕ та же папка
 * и НЕ те же функции.
 *
 * Причина отдельного модуля: у lib/privateFiles.ts есть ночная уборка
 * (`cleanupPrivateFiles`, RETENTION_DAYS = 180) — вложения переписки одноразовые
 * и годятся на удаление через полгода. Документы сделки — постоянная запись
 * (свидетельство о собственности проданной квартиры может понадобиться и через
 * год), общая папка тихо стёрла бы их вместе с перепиской. Поэтому отдельная
 * папка `uploads-deal-docs`, без какой-либо автоматической уборки.
 */
const dealDocsDir = path.resolve(process.env.DEAL_DOCS_DIR ?? "./uploads-deal-docs");

fs.mkdirSync(dealDocsDir, { recursive: true });


/** Документы — сканы/фото и PDF, шире картинок и звука в lib/privateFiles.ts. */
const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

const OWN_NAME_RE = /^[0-9a-f-]{36}\.[a-z0-9]{2,4}$/i;

export function saveDealDocumentFile(data: Buffer, mimeType: string): string | null {
  const ext = EXT_BY_MIME[mimeType.split(";")[0].trim()];
  if (!ext) return null;
  const name = `${randomUUID()}.${ext}`;
  try {
    fs.writeFileSync(path.join(dealDocsDir, name), data);
    return name;
  } catch (err) {
    // Тот же разбор, что в lib/privateFiles.ts: пустой `catch` делал отказ диска
    // неотличимым от неподдерживаемого формата, и маршрут отвечал агенту
    // «Недопустимый формат файла» на кончившееся место. Поведение прежнее
    // (возвращаем null), но сбой теперь видно в журнале.
    void logSystemError("api", `Документ сделки не сохранился на диск (${mimeType}): ${describeError(err)}`);
    return null;
  }
}

/**
 * Полный путь к файлу по имени, ТОЛЬКО если имя — наш собственный uuid.ext
 * (см. docstring OWN_NAME_RE в lib/privateFiles.ts — тот же приём защиты от
 * обхода пути через имя файла).
 */
export function dealDocumentFilePath(name: string): string | null {
  if (!OWN_NAME_RE.test(name)) return null;
  const full = path.join(dealDocsDir, name);
  if (path.dirname(path.resolve(full)) !== dealDocsDir) return null;
  return fs.existsSync(full) ? full : null;
}

export function dealDocumentMimeType(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const found = Object.entries(EXT_BY_MIME).find(([, e]) => e === ext);
  return found ? found[0] : "application/octet-stream";
}

/** Удаляет файл по имени. Best-effort — вызывающий не должен падать из-за уборки диска. */
export function deleteDealDocumentFile(name: string): void {
  const full = dealDocumentFilePath(name);
  if (!full) return;
  try {
    fs.unlinkSync(full);
  } catch {
    // Не наша забота: запись в базе уже удаляется отдельно, зависший файл на
    // диске не блокирует работу CRM (в отличие от lib/privateFiles.ts, где
    // ночная уборка — часть контракта, здесь её нет вовсе — см. докстринг выше).
  }
}
