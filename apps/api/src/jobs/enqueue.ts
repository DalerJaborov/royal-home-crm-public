import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "../db.js";
import { isPultModuleEnabled } from "../lib/pultModules.js";
import { pultModuleOfJob } from "./jobModules.js";
import { logSystemError } from "../lib/systemError.js";
import { isPrivateBackgroundJob } from "../lib/backgroundJobPrivacy.js";
import { isPrivateOperation, withInvestigationPrivacy } from "../lib/investigationOperations.js";

export type EnqueueResult = { enqueued: true } | { enqueued: false; skipped: "module:off" | "error" };

/**
 * Постановка задания в очередь (чертёж §2). Зовётся из ЛЮБОГО процесса —
 * HTTP-роут ставит, worker исполняет.
 *
 * dedupeKey — идемпотентность постановки, двумя режимами:
 *  - задание с тем же ключом ЖДЁТ или ИСПОЛНЯЕТСЯ → no-op (шквал правок
 *    схлопывается в один прогон);
 *  - уже DONE/GIVEN_UP → перезаводится заново (attempts=0, runAt=сейчас):
 *    «geocode:{id}» обязан срабатывать на каждую правку адреса, а не один
 *    раз за жизнь объекта.
 *
 * Постановка best-effort по контракту вызывающих: все семь первых потребителей
 * (§2.3) — бывшие fire-and-forget, где сбой не имеет права ронять сам запрос.
 * Поэтому ошибки глотаются в консоль, а не летят наверх.
 *
 * maxAttempts задаёт вызывающий, а не реестр обработчиков: HTTP-процесс ставит
 * задания, не загружая обработчиков вовсе (см. докстринг registry.ts про
 * разрыв цикла импортов) — узнать предел попыток ему не у кого.
 */
export async function enqueueBackgroundJob(input: {
  type: string;
  payload: Prisma.InputJsonValue;
  maxAttempts: number;
  dedupeKey?: string;
  /** Отложенный старт; по умолчанию — сейчас. */
  runAt?: Date;
}): Promise<EnqueueResult> {
  const privateJob = isPrivateOperation() || await isPrivateBackgroundJob(input).catch(() => true);
  if (privateJob && input.payload && typeof input.payload === "object" && !Array.isArray(input.payload)) input = { ...input, payload: { ...input.payload, investigationOnly: true } };
  return withInvestigationPrivacy(privateJob, async () => {
  // Гейт по модулю пульта (jobs/jobModules.ts): задание выключенного модуля
  // не ставится вовсе — так оно не занимает партию и не тратит ресурсы.
  const module = pultModuleOfJob(input.type);
  if (module && !(await isPultModuleEnabled(module))) {
    return { enqueued: false, skipped: "module:off" };
  }
  const data = {
    type: input.type,
    payload: input.payload,
    dedupeKey: input.dedupeKey ?? null,
    // Без runAt срабатывает @default(now()) в схеме — часами САМОЙ Postgres,
    // а не Node: claimBatch читает "runAt" <= now() тем же now() базы. Если
    // здесь подставить new Date() (часы приложения), небольшой рассинхрон
    // часов делает свежепоставленное задание «из будущего» для первого же
    // тика — воспроизводилось в CI флаки-тестах (постановка → тик почти
    // мгновенно, окно на рассинхрон меньше секунды, но хватало).
    ...(input.runAt ? { runAt: input.runAt } : {}),
    maxAttempts: input.maxAttempts,
  };
  try {
    await prisma.backgroundJob.create({ data });
    return { enqueued: true };
  } catch (err) {
    if ((err as { code?: string }).code !== "P2002" || !input.dedupeKey) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[jobs] постановка задания:", message);
      // В журнал ошибок (07.10.2026): пока это был только console.error, отказ базы
      // при постановке исчезал бесследно, а вызывающий без await не узнавал о нём
      // вовсе. Ключ по ТИПУ задания — один тип не засоряет журнал на каждый вызов.
      void logSystemError("background-jobs", `Не удалось поставить задание «${input.type}» в очередь: ${message}`, {
        dedupKey: `enqueue-failed:${input.type}`,
      });
      return { enqueued: false, skipped: "error" };
    }
    // Ключ занят — значит задание ЖДЁТ, ИСПОЛНЯЕТСЯ или проходит лестницу
    // повторов (с 13.09.2026 ключ живёт до финального статуса, см. runner.ts —
    // до этого он снимался уже на первом захвате, и повторная постановка в
    // разгар ретраев создавала дубль). Ждущее/исполняющееся не трогаем: у него
    // есть срок, и работа всё равно будет сделана позже. Ветка перезавода ниже
    // осталась для строк, заведённых до 27.08.2026 либо созданных до 13.09 —
    // у них ключ мог остаться на DONE/GIVEN_UP.
    await prisma.backgroundJob
      .updateMany({
        where: { dedupeKey: input.dedupeKey, status: { in: ["DONE", "GIVEN_UP"] } },
        data: {
          payload: input.payload,
          status: "PENDING",
          // UPDATE не подхватывает @default схемы (тот срабатывает только на
          // INSERT) — здесь, в отличие от create() выше, часы Node неизбежны.
          runAt: input.runAt ?? new Date(),
          attempts: 0,
          maxAttempts: input.maxAttempts,
          lastError: null,
          lockedAt: null,
          lockedBy: null,
        },
      })
      .catch((err2) => console.error("[jobs] перезавод задания:", err2 instanceof Error ? err2.message : err2));
    return { enqueued: true };
  }
  });
}
