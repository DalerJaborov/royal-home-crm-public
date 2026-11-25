import type { Request, Response } from "express";
import {
  UPLOAD_ASYNC_HEADER,
  UPLOAD_RESULT_KEEP_MS,
  uploadErrorBody,
  type UploadErrorBody,
  type UploadSessionState,
} from "@royal-home/shared";
import { UploadError } from "./uploadErrors.js";
import {
  ASSEMBLY_LOCK_STALE_MS,
  finishLocalUploadSession,
  listLocalUploadParts,
  lockLocalUploadAssembly,
  readLocalUploadSessionState,
  writeLocalUploadSessionState,
} from "./localVideoStorage.js";
import { reportUploadError, sendUploadError } from "./uploadHttp.js";
import { logSystemError } from "./systemError.js";

/**
 * СБОРКА ФАЙЛА ИЗ ЧАСТЕЙ — ОДИН ПОРЯДОК ДЛЯ ТРЁХ ВИДОВ ЗАГРУЗКИ (25.11.2026, волна B).
 *
 * Что было не так:
 *  - сборка шла синхронно в запросе: свободный ролик 2 ГБ (склейка + хеш + ffprobe +
 *    перепаковка) — минуты, а Cloudflare рвёт ответ на сотой секунде; клиент повторял «собрать»
 *    в уже удалённую сессию → 404 → заливал 2 ГБ заново → второй пост;
 *  - части стирались сразу после склейки, до записи в базу: упала запись — каждый повтор
 *    отвечал «не удалось собрать» навсегда;
 *  - две вкладки собирали одну сессию одновременно (сырое видео — без замка вовсе).
 *
 * Как теперь (runUploadCompletion):
 *  1. Итог уже есть (state.json, хранится сутки) — отдаём его же: повтор «собрать» после
 *     обрыва получает тот же ответ, а не 404 и не второй объект.
 *  2. Замок сборки (lockLocalUploadAssembly, с пульсом). Занят — синхронный запрос ждёт итога
 *     до SYNC_WAIT_MS и отдаёт его; асинхронный сразу получает 202 с состоянием.
 *  3. Работа (`work`) собирает файл и закрепляет результат (запись в базе, перенос файла).
 *     Ответ 2xx → части удаляются, итог пишется в state.json. Отказ работы (бросок) — части
 *     ОСТАЮТСЯ, повтор не требует загружать файл заново.
 *  4. Заголовок `X-Upload-Async: 1` — ответ 202 сразу, работа в фоне, состояние отдаёт GET
 *     сессии. Без заголовка — прежний синхронный ответ (открытые старые вкладки).
 */

export interface StoredUploadState {
  state: UploadSessionState;
  /** Чья сессия: `property:<id>` или `agent:<id>` — чужой итог не отдаём. */
  owner: string;
  updatedAt: string;
  result?: { status: number; body: unknown };
  error?: UploadErrorBody;
}

export interface CompletionOutcome {
  status: number;
  body: unknown;
  /** Убрать части после ответа. По умолчанию — только при 2xx. */
  finalize?: boolean;
}

/** Синхронный повтор при идущей сборке ждёт её итога столько, сколько терпит прокси. */
const SYNC_WAIT_MS = 60_000;
const SYNC_POLL_MS = 1_000;
const STATE_HEARTBEAT_MS = 30_000;

export function wantsAsyncUpload(req: Request): boolean {
  return req.get(UPLOAD_ASYNC_HEADER) === "1" || req.query.async === "1";
}

function isStoredState(v: unknown): v is StoredUploadState {
  return !!v && typeof v === "object" && typeof (v as StoredUploadState).state === "string" && typeof (v as StoredUploadState).owner === "string";
}

/**
 * Итог сессии из state.json (null — нет или чужой). «Собирается» без пульса дольше
 * ASSEMBLY_LOCK_STALE_MS — процесс умер посреди сборки: отдаём `failed` с возможностью
 * повторить, а не вечное «собирается».
 */
export async function readUploadState(sessionId: string, owner: string, now = Date.now()): Promise<StoredUploadState | null> {
  const raw = await readLocalUploadSessionState(sessionId);
  if (!isStoredState(raw) || raw.owner !== owner) return null;
  const age = now - Date.parse(raw.updatedAt);
  if ((raw.state === "assembling" || raw.state === "processing") && age > ASSEMBLY_LOCK_STALE_MS) {
    return {
      ...raw,
      state: "failed",
      error: uploadErrorBody("STORAGE_FAILED", { message: "Сборка файла прервалась — нажмите «собрать» ещё раз, части на месте" }),
    };
  }
  if ((raw.state === "done" || raw.state === "failed") && age > UPLOAD_RESULT_KEEP_MS) return null;
  return raw;
}

async function saveState(sessionId: string, state: Omit<StoredUploadState, "updatedAt">): Promise<void> {
  await writeLocalUploadSessionState(sessionId, { ...state, updatedAt: new Date().toISOString() }).catch((err) =>
    console.error(`[upload] не записать состояние сессии ${sessionId}:`, err instanceof Error ? err.message : err)
  );
}

function replyStored(res: Response, stored: StoredUploadState, asyncMode: boolean, sessionId: string): void {
  if (asyncMode) {
    res.status(stored.state === "done" ? 200 : 202).json({ sessionId, state: stored.state, result: stored.result, error: stored.error });
    return;
  }
  // Итог с ответом (готово или отказ по содержимому) — повтор получает тот же код и тело.
  if (stored.result) {
    res.status(stored.result.status).json(stored.result.body);
    return;
  }
  if (stored.state === "failed" && stored.error) {
    res.status(stored.error.code === "DISK_FULL" ? 507 : 500).json(stored.error);
    return;
  }
  res.status(409).json(uploadErrorBody("ASSEMBLING"));
}

/** Ответ сохранённым итогом сессии (повтор «собрать», когда строки сессии уже нет). */
export function replyStoredUpload(req: Request, res: Response, stored: StoredUploadState, sessionId: string): void {
  replyStored(res, stored, wantsAsyncUpload(req), sessionId);
}

async function waitForResult(sessionId: string, owner: string): Promise<StoredUploadState | null> {
  const deadline = Date.now() + SYNC_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, SYNC_POLL_MS));
    const s = await readUploadState(sessionId, owner);
    if (s && (s.state === "done" || s.state === "failed")) return s;
  }
  return null;
}

export interface RunUploadCompletionInput {
  req: Request;
  res: Response;
  sessionId: string;
  owner: string;
  /** Для журнала: «видео объекта», «ролик черновика»… */
  what: string;
  /** Сборка и закрепление результата. Бросок — части остаются. `setPhase` — «обрабатываю». */
  work: (setPhase: (phase: "assembling" | "processing") => void) => Promise<CompletionOutcome>;
}

export async function runUploadCompletion(input: RunUploadCompletionInput): Promise<void> {
  const { req, res, sessionId, owner, what } = input;
  const asyncMode = wantsAsyncUpload(req);

  const prior = await readUploadState(sessionId, owner);
  if (prior?.state === "done") return replyStored(res, prior, asyncMode, sessionId);
  // Отвергнут по содержимому и части уже убраны — повтор ничего не изменит: тот же ответ,
  // а не «дошлите все части» (старая вкладка залила бы файл заново по кругу).
  if (prior?.state === "failed" && prior.result && (await listLocalUploadParts(sessionId)).length === 0) {
    return replyStored(res, prior, asyncMode, sessionId);
  }

  let lock;
  try {
    lock = await lockLocalUploadAssembly(sessionId);
  } catch (err) {
    if (sendUploadError(res, err, what)) return;
    throw err;
  }
  if (!lock) {
    if (asyncMode) {
      res.status(202).json({ sessionId, state: prior?.state === "processing" ? "processing" : "assembling" });
      return;
    }
    // Ждём, только если сборка правда идёт (её состояние записано и живо): старая вкладка
    // получит итог первой сборки, а не отказ.
    const running = await readUploadState(sessionId, owner);
    const settled = running && (running.state === "assembling" || running.state === "processing") ? await waitForResult(sessionId, owner) : null;
    if (settled) return replyStored(res, settled, false, sessionId);
    // Старые вкладки на 409 со списком частей идут на следующий круг (переспрашивают сервер),
    // а не показывают отказ — список правдивый: это части, которые уже на сервере.
    res.status(409).json(uploadErrorBody("ASSEMBLING", { extra: { uploadedPartNumbers: await listLocalUploadParts(sessionId) } }));
    return;
  }

  /**
   * Записи состояния идут строго по очереди, а после итога — не идут вовсе: иначе запоздавший
   * пульс («собирается») мог лечь ПОВЕРХ итога «готово», и через две минуты сессия читалась бы
   * как прерванная.
   */
  let phase: "assembling" | "processing" = "assembling";
  let closed = false;
  let chain: Promise<void> = Promise.resolve();
  const queueState = (): Promise<void> => {
    chain = chain.then(() => (closed ? undefined : saveState(sessionId, { state: phase, owner })));
    return chain;
  };
  await queueState();
  const heartbeat = setInterval(() => void queueState(), STATE_HEARTBEAT_MS);
  heartbeat.unref();
  const setPhase = (next: "assembling" | "processing") => {
    phase = next;
    void queueState();
  };
  const closeStates = async () => {
    closed = true;
    clearInterval(heartbeat);
    await chain;
  };

  const execute = async (): Promise<{ outcome?: CompletionOutcome; error?: unknown }> => {
    try {
      const outcome = await input.work(setPhase);
      const finalize = outcome.finalize ?? (outcome.status >= 200 && outcome.status < 300);
      await closeStates();
      if (finalize) {
        const state: StoredUploadState = {
          state: outcome.status < 300 ? "done" : "failed",
          owner,
          updatedAt: new Date().toISOString(),
          result: { status: outcome.status, body: outcome.body },
          ...(outcome.status >= 300 ? { error: errorBodyFromOutcome(outcome) } : {}),
        };
        if (!(await finishLocalUploadSession(sessionId, state))) {
          void logSystemError("storage", `Загрузка (${what}): результат закреплён, но части сессии не убрались с диска — уберёт ночная уборка`, {
            dedupKey: "upload-finish-failed",
          });
        }
      } else {
        await saveState(sessionId, { state: "failed", owner, result: { status: outcome.status, body: outcome.body }, error: errorBodyFromOutcome(outcome) });
      }
      return { outcome };
    } catch (err) {
      await closeStates();
      const body =
        err instanceof UploadError
          ? err.body()
          : uploadErrorBody("STORAGE_FAILED", { message: "Не удалось завершить загрузку — попробуйте ещё раз, части на месте" });
      await saveState(sessionId, { state: "failed", owner, error: body });
      return { error: err };
    } finally {
      await closeStates();
      await lock.release();
    }
  };

  if (asyncMode) {
    res.status(202).json({ sessionId, state: "assembling" });
    void execute().then(({ error }) => {
      if (error && !(error instanceof UploadError)) {
        void logSystemError("storage", `Фоновая сборка загрузки (${what}) упала: ${error instanceof Error ? error.message : String(error)}`, {
          dedupKey: `upload-async:${what}`,
        });
      } else if (error instanceof UploadError) {
        // Тот же журнал тревог, что у синхронного ответа.
        reportUploadError(error, what);
      }
    });
    return;
  }

  const { outcome, error } = await execute();
  if (error !== undefined) {
    if (sendUploadError(res, error, what)) return;
    throw error;
  }
  res.status(outcome!.status).json(outcome!.body);
}

function errorBodyFromOutcome(outcome: CompletionOutcome): UploadErrorBody {
  const body = (outcome.body ?? {}) as Record<string, unknown>;
  if (typeof body.code === "string" && typeof body.retryable === "boolean" && typeof body.message === "string") {
    return body as UploadErrorBody;
  }
  const message = typeof body.error === "string" ? body.error : "Файл не принят";
  return { ...body, error: message, message, code: typeof body.code === "string" ? body.code : "REJECTED", retryable: outcome.status >= 500 };
}
