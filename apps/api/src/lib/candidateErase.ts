/**
 * Удаление анкет кандидатов НАВСЕГДА (22.10.2026, раздел «Подбор сотрудников»).
 *
 * Зависимые записи JobApplication:
 *  - InterviewInviteCall — FK с onDelete: Cascade, уходит сам; удаляем явно, чтобы
 *    не зависеть от того, как применена миграция;
 *  - RecruitmentCommunication — ссылка на анкету БЕЗ внешнего ключа (просто
 *    строка), каскада нет: без явного удаления остались бы осиротевшие записи
 *    с телефонами и текстами приглашений;
 *  - файлы (резюме, портфолио, голосовая заметка отказа) лежат в закрытом
 *    хранилище вне базы — стираются ПОСЛЕ коммита (`removeCandidateFiles`).
 *
 * Журнал действий (AuditLog) не трогаем: он хранит маскированный след.
 */
import { customerRecruitmentPortfolioSchema } from "@royal-home/shared";
type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
import { prisma } from "../db.js";
import { deletePrivateFileByName, isConversationAttachment } from "./privateFiles.js";
import { logSystemError } from "./systemError.js";
import { describeError } from "./describeError.js";

const VOICE_NOTE_NAME_RE = /^\/me\/voice-notes\/([0-9a-f-]{36}\.[a-z0-9]{2,4})$/i;

/** Имена файлов анкеты: резюме, файлы портфолио, голосовая заметка причины отказа. */
export function candidateFileNames(row: {
  cvFile: string | null;
  customerPortfolio: unknown;
  rejectionReasonVoiceUrl: string | null;
}): string[] {
  const names = new Set<string>();
  if (row.cvFile) names.add(row.cvFile);
  const portfolio = customerRecruitmentPortfolioSchema.safeParse(row.customerPortfolio);
  if (portfolio.success) {
    for (const item of portfolio.data) if ("file" in item) names.add(item.file);
  }
  const voice = row.rejectionReasonVoiceUrl ? VOICE_NOTE_NAME_RE.exec(row.rejectionReasonVoiceUrl) : null;
  if (voice) names.add(voice[1]);
  return [...names];
}

/** Стирает анкеты и зависимые записи в переданной транзакции. Возвращает имена
 *  файлов, которые надо убрать из хранилища после её коммита. */
export async function eraseJobApplicationsTx(tx: Tx, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await tx.jobApplication.findMany({
    where: { id: { in: ids } },
    select: { cvFile: true, customerPortfolio: true, rejectionReasonVoiceUrl: true },
  });
  const files = [...new Set(rows.flatMap(candidateFileNames))];
  await tx.recruitmentCommunication.deleteMany({ where: { jobApplicationId: { in: ids } } });
  await tx.interviewInviteCall.deleteMany({ where: { jobApplicationId: { in: ids } } });
  await tx.jobApplication.deleteMany({ where: { id: { in: ids } } });
  return files;
}

/**
 * Убирает файлы из закрытого хранилища после коммита. Файл, который остался
 * вложением переписки (резюме и портфолио приходят из диалога) или нужен другой
 * анкете, НЕ трогаем: переписка клиента не принадлежит анкете. Любая ошибка —
 * в журнал ошибок, наружу не бросается (анкета уже удалена).
 */
export async function removeCandidateFiles(files: string[]): Promise<{ removed: number; kept: number }> {
  let removed = 0;
  let kept = 0;
  for (const name of files) {
    try {
      const stillUsed =
        (await isConversationAttachment(name)) ||
        (await prisma.jobApplication.count({
          where: { OR: [
            { cvFile: name },
            { rejectionReasonVoiceUrl: { endsWith: name } },
            // A file may survive only as another application's portfolio item.
            // PostgreSQL JSON containment matches the file field even when the
            // item also stores kind, MIME type and its source event witness.
            { customerPortfolio: { array_contains: [{ file: name }] } },
          ] },
        })) > 0;
      if (stillUsed) {
        kept++;
        continue;
      }
      if (deletePrivateFileByName(name)) removed++;
    } catch (err) {
      void logSystemError("storage", `Файл удалённой анкеты кандидата не стёрт: ${describeError(err)}`);
    }
  }
  return { removed, kept };
}
