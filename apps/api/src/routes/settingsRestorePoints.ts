import { canViewInvestigations } from "@royal-home/shared";
import { isPrivateSettingsField, saveWithInvestigationControlAudit } from "../lib/investigationSettingsAudit.js";
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { logAudit } from "../lib/audit.js";
import { logSystemError } from "../lib/systemError.js";
import { applySettingsSideEffects } from "../lib/settingsSideEffects.js";
import {
  captureSettingsSnapshot,
  diffSnapshot,
  dropUnavailableStaffFromPlan,
  planRestore,
  secretsRestorable,
  SNAPSHOT_KEEP_COUNT,
  SNAPSHOT_KEEP_DAYS,
  type SnapshotPayload,
} from "../lib/settingsSnapshots.js";

/**
 * ТОЧКИ ВОЗВРАТА НАСТРОЕК — список и откат.
 *
 * Почему это не «сбросить всё на умолчания»: умолчания строки Settings пусты, и
 * такой сброс стёр бы маркеры Instagram, ключи Gemini, пароли АТС и промт бота —
 * авария больше той, ради которой кнопку жмут. Смысл раздела в другом: вернуться
 * к состоянию, которое ТОЧНО работало, и не потерять при этом текущее (откат сам
 * снимает точку возврата — см. ниже).
 *
 * Права те же, что у сохранения настроек: settings.manage + свежее подтверждение
 * личности. Отдельного права нет намеренно — «вернуть настройки к прошлому виду»
 * это ровно то же полномочие, что «поменять настройки», и разводить их означало бы
 * выдать одно, забыв про другое.
 */
export const settingsRestorePointsRouter = Router();

const listQuerySchema = z.object({
  /** Предел выборки обязателен: маршрут возвращает массив. */
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

settingsRestorePointsRouter.get("/", requireAuth, requirePermission("settings.manage"), async (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ error: "Неверные параметры", details: parsed.error.flatten() });
  }
  const [points, current] = await Promise.all([
    prisma.settingsSnapshot.findMany({ orderBy: { createdAt: "desc" }, take: parsed.data.limit }),
    prisma.settings.findUnique({ where: { id: "singleton" } }),
  ]);

  res.json({
    retention: { keepCount: SNAPSHOT_KEEP_COUNT, keepDays: SNAPSHOT_KEEP_DAYS },
    items: points.map((point) => {
      // Отличия считаются от ДЕЙСТВУЮЩИХ настроек, а не от соседней точки: человек
      // выбирает, «куда вернуться отсюда», и видеть должен именно это.
      const changes = current ? diffSnapshot(point.payload as SnapshotPayload, current) : [];
      return {
        id: point.id,
        createdAt: point.createdAt,
        agentId: point.agentId,
        agentName: point.agentName,
        reason: point.reason,
        changedFields: point.changedFields.filter(field => canViewInvestigations(req.agent?.role) || !isPrivateSettingsField(field)),
        /** false — снимок зашифрован другим ключом: секреты откат не тронет. */
        secretsRestorable: secretsRestorable(point.keyFingerprint),
        changes: changes.filter(change => canViewInvestigations(req.agent?.role) || !isPrivateSettingsField(change.field)),
      };
    }),
  });
});

/**
 * ВОЗВРАТ К ТОЧКЕ.
 *
 * Три вещи, без которых откат опасен, и все три сделаны здесь:
 *  1. Откат сам по себе изменение — значит перед ним снимается своя точка. Иначе
 *     неудачный откат необратим, и кнопка «вернуть как было» становится ловушкой.
 *  2. Секреты возвращаются только если снимок зашифрован ДЕЙСТВУЮЩИМ ключом. При
 *     смене SETTINGS_ENCRYPTION_KEY старые значения не расшифровываются, и запись
 *     их обратно дала бы нерабочие маркеры, внешне неотличимые от рабочих. Такие
 *     поля пропускаются, действующие значения остаются, и ответ честно перечисляет
 *     пропущенное.
 *  3. Побочные действия те же, что у обычного сохранения (переподключение к АТС,
 *     перекладывание правила «если не ответил» на станцию) — см.
 *     lib/settingsSideEffects.ts.
 *
 * Чего откат НЕ возвращает — и почему:
 *  • подключённые аккаунты мессенджеров (таблица MessengerAccount), логотип-файл,
 *    звуки телефонии и звонок входящего: это не поля строки Settings, а отдельные
 *    записи и файлы. Их снимок не хранит вовсе, и трогать их откат не вправе;
 *  • уже отправленные сообщения, начисленные баллы и посчитанный KPI: настройки
 *    решают, как считать ДАЛЬШЕ, задним числом откат ничего не пересчитывает.
 */
settingsRestorePointsRouter.post(
  "/:id/restore",
  requireAuth,
  requirePermission("settings.manage"),
  requireElevation,
  async (req, res) => {
    const point = await prisma.settingsSnapshot.findUnique({ where: { id: req.params.id } });
    if (!point) return res.status(404).json({ error: "Точка возврата не найдена" });

    const current = await prisma.settings.findUnique({ where: { id: "singleton" } });
    if (!current) return res.status(409).json({ error: "Настройки ещё не созданы — возвращать нечего" });

    const payload = point.payload as SnapshotPayload;
    const plan = planRestore(payload, current, point.keyFingerprint);
    if (!canViewInvestigations(req.agent?.role)) {
      for (const field of Object.keys(plan.data)) if (isPrivateSettingsField(field)) delete plan.data[field];
      plan.changedFields = plan.changedFields.filter(field => !isPrivateSettingsField(field));
    }
    // Уволенный/замороженный с тех пор сотрудник в поля «монтажёр/дежурный» не
    // возвращается — та же планка, что у обычного сохранения (G7, 02.10.2026).
    const skippedStaff = await dropUnavailableStaffFromPlan(plan);
    if (plan.changedFields.length === 0) {
      return res.status(409).json({
        error: plan.skippedSecrets.length
          ? "Отличаются только секреты, а они зашифрованы другим ключом — вернуть их нельзя"
          : "Настройки уже совпадают с этой точкой",
        skippedSecrets: plan.skippedSecrets,
        skippedStaff,
      });
    }

    // Точка ПЕРЕД откатом. Не best-effort: без неё откат необратим, и это ровно та
    // ситуация, ради которой раздел существует. Сбой здесь — отказ операции.
    const agent = await prisma.agent.findUnique({
      where: { id: req.agent?.id ?? "" },
      select: { fullName: true },
    });
    let backupId: string | null = null;
    try {
      const backup = await captureSettingsSnapshot({
        agentId: req.agent?.id ?? null,
        agentName: agent?.fullName ?? "Неизвестно",
        reason: "restore",
        nextData: plan.data,
      });
      backupId = backup?.id ?? null;
    } catch (err) {
      await logSystemError(
        "api",
        `Точка возврата перед откатом не снялась: ${err instanceof Error ? err.message : String(err)}`
      );
      return res.status(500).json({ error: "Не удалось сохранить текущее состояние — откат отменён" });
    }

    await saveWithInvestigationControlAudit(plan.data, { id: req.agent!.id, name: agent?.fullName ?? "Неизвестно" }, tx => tx.settings.update({ where: { id: "singleton" }, data: plan.data }));
    applySettingsSideEffects(plan.changedFields);

    // В журнал — куда вернулись и какие поля тронули. Значения секретов сюда не
    // попадают никогда, как и при обычном сохранении настроек.
    logAudit(req, "SETTINGS_RESTORE", "Settings", "singleton", {
      restorePointId: point.id,
      restorePointAt: point.createdAt.toISOString(),
      fields: plan.changedFields,
      skippedSecrets: plan.skippedSecrets,
      skippedStaff,
      backupPointId: backupId,
    });

    res.json({
      ok: true,
      restoredFields: plan.changedFields,
      skippedSecrets: plan.skippedSecrets,
      skippedStaff,
      backupPointId: backupId,
    });
  }
);
