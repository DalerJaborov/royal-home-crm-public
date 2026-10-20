import { api } from "./api";
import { useAuthStore } from "../store/auth";
import { formatUploadIssueMessage, type UploadIssueInfo } from "./uploadFormat";

/**
 * Автоматический репорт ошибок браузера в CRM (POST /errors): баги фронта видны
 * администратору в «Здоровье системы» и попадают в утренний дайджест директора —
 * не ждём, пока о поломке расскажет агент. Дедуп: одна и та же ошибка шлётся не
 * чаще раза в 5 минут, максимум 20 репортов за сессию (защита от циклов).
 */
const sentAt = new Map<string, number>();
let totalSent = 0;
const DEDUPE_MS = 5 * 60 * 1000;
const MAX_PER_SESSION = 20;

function report(message: string, stack?: string) {
  if (!useAuthStore.getState().hasSession) return;
  if (totalSent >= MAX_PER_SESSION) return;
  const key = message.slice(0, 200);
  const last = sentAt.get(key);
  if (last && Date.now() - last < DEDUPE_MS) return;
  sentAt.set(key, Date.now());
  totalSent++;
  api("/errors", {
    method: "POST",
    body: { message: message.slice(0, 2000), stack: stack?.slice(0, 8000), url: location.pathname },
  }).catch(() => {});
}

/**
 * Телеметрия отказов загрузки (23.09.2026, разбор жалобы «не грузится»):
 * очередь карточки (uploadQueue.ts) и очередь мастера (draftUploads.ts) видят
 * каждый отказ отправки сами, но до сих пор никуда его не сообщали — узнать о
 * простое можно было только живой жалобой владельца. Поверх того же `report`,
 * что и у ошибок скрипта: тот же дедуп (5 минут, 200 первых символов ключа —
 * поэтому номер попытки в сообщении должен попадать в эти 200 символов, см.
 * formatUploadIssueMessage), тот же источник правды в ErrorLog для утреннего
 * отчёта директора.
 */
export function reportUploadIssue(info: UploadIssueInfo): void {
  report(formatUploadIssueMessage(info));
}

export function initErrorReporter() {
  window.addEventListener("error", (e) => {
    report(e.message || "Неизвестная ошибка", e.error instanceof Error ? e.error.stack : undefined);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    // Ошибки API (4xx/5xx) не репортим — серверные 5xx уже пишутся на бэке,
    // а 4xx (валидация, права) — штатные ответы, не баги фронта.
    if (reason && typeof reason === "object" && "status" in reason) return;
    report(
      reason instanceof Error ? reason.message : String(reason ?? "Отклонённый промис"),
      reason instanceof Error ? reason.stack : undefined
    );
  });
}
