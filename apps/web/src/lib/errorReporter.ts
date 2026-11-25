import { api } from "./api";
import { useAuthStore } from "../store/auth";
import { formatUploadIssueMessage, type UploadIssueInfo } from "./uploadFormat";
import { connectionSnapshot } from "./upload/network";

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

/**
 * Сборка вкладки — первой строкой стека (20.11.2026). Падение 18.11 пришло со
 * стеком `PultClean-Cbv4Qzsu.js:2:53534`, и чтобы понять, что телефон жил на
 * сборке старше суток, пришлось собирать старые коммиты и искать смещение.
 * С версией в записи это видно сразу: `git show <версия>`.
 */
function withBuild(stack?: string): string | undefined {
  const build = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "";
  if (!build) return stack;
  return stack ? `сборка ${build}\n${stack}` : `сборка ${build}`;
}

/**
 * Окончательные отказы загрузок пишутся ВСЕГДА (25.11.2026, находка 7): предел в 20
 * записей за сессию забивали повторы ролика («попытка 2/10, 3/10…»), и самая нужная
 * строка — «сдалась» — до журнала не доходила. У них свой запас, отдельный от общего.
 */
const MAX_FINAL_PER_SESSION = 50;
let finalSent = 0;
/**
 * Промежуточные отчёты загрузки («попытка 2/10…») не едят общий предел в 20 записей
 * (ревью 26.11.2026): ролик с десятью повторами выбирал половину, и обычные ошибки
 * скрипта после него не доходили до журнала. У них свой потолок и свой счётчик.
 */
const MAX_UPLOAD_PROGRESS_PER_SESSION = 10;
let uploadProgressSent = 0;

/** Отправка записи; промис — принял ли её сервер (false — не ушла: нет сессии, предел, повтор, сеть). */
function send(message: string, stack?: string, opts: { final?: boolean; upload?: boolean } = {}): Promise<boolean> {
  if (!useAuthStore.getState().hasSession) return Promise.resolve(false);
  const progress = !opts.final && opts.upload === true;
  const used = opts.final ? finalSent : progress ? uploadProgressSent : totalSent;
  const limit = opts.final ? MAX_FINAL_PER_SESSION : progress ? MAX_UPLOAD_PROGRESS_PER_SESSION : MAX_PER_SESSION;
  if (used >= limit) return Promise.resolve(false);
  // Окончательный отказ не глушится дедупом промежуточных строк с тем же началом.
  const key = (opts.final ? "final:" : "") + message.slice(0, 200);
  const last = sentAt.get(key);
  if (last && Date.now() - last < DEDUPE_MS) return Promise.resolve(false);
  sentAt.set(key, Date.now());
  if (opts.final) finalSent++;
  else if (progress) uploadProgressSent++;
  else totalSent++;
  return api("/errors", {
    method: "POST",
    body: { message: message.slice(0, 2000), stack: withBuild(stack)?.slice(0, 8000), url: location.pathname },
  }).then(() => true, () => false);
}

function report(message: string, stack?: string) {
  void send(message, stack);
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
  void send(formatUploadIssueMessage(withUploadEnv(info)), undefined, { final: info.final === true, upload: true });
}

/** Видимость вкладки и канал — одно место заполняет их у всех пяти загрузок. */
function withUploadEnv(info: UploadIssueInfo): UploadIssueInfo {
  const out = { ...info };
  if (!out.visibility && typeof document !== "undefined") out.visibility = document.visibilityState;
  if (!out.connection) {
    const c = connectionSnapshot();
    const parts = [c.effectiveType, c.downlinkMbps != null ? `${String(c.downlinkMbps).replace(".", ",")} Мбит/с` : null, c.saveData ? "экономия трафика" : null];
    const label = parts.filter(Boolean).join(" ");
    if (label) out.connection = label;
  }
  return out;
}

/**
 * Самолечение пустых списков (lib/emptyListGuard.ts): тихая запись в ErrorLog
 * с меткой «[empty-list-guard]». Тот же `report` (дедуп 5 минут, предел сессии);
 * частоту на устройство ограничивает сам guard. Источник в журнале — «web»,
 * отличать по метке в начале сообщения.
 */
export function reportEmptyListGuard(message: string): void {
  report(message);
}

/**
 * Сдача лестницы обновления (lib/appUpdateReload.ts, 21.11.2026). Снимок среды
 * передаётся ЯВНО вторым полем, а не через error.stack: Safari и Chrome на iOS
 * отдают в stack только адреса строк, и подробности с телефонов терялись — ровно
 * с тех, ради которых снимок собирается. Сообщение — ключ дедупа, поэтому
 * переменные факты живут в `details`. Промис — приняли ли запись: без
 * восстановленной сессии (старт вкладки) она не уходит, и лестница доложит позже
 * (lib/appUpdateReload.ts, reportUpdateGiveUpOnce ставит отметку только по true).
 */
export function reportUpdateGiveUp(message: string, details: string): Promise<boolean> {
  return send(message, details);
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

/** Только для тестов: сбросить счётчики и дедуп. */
export function resetErrorReporterForTests(): void {
  sentAt.clear();
  totalSent = 0;
  finalSent = 0;
  uploadProgressSent = 0;
}
