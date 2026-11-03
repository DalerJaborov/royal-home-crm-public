import type { AssistantActionOutcome, AssistantActionView } from "@royal-home/shared";
import { AssistantActionRequestError } from "../../lib/assistantStream";

/**
 * СОСТОЯНИЕ КАРТОЧКИ ПОДТВЕРЖДЕНИЯ (П4а, docs/design/internal-assistant-
 * architecture-2026-10-31.md §2.3 и §4 п. 4) — отдельно от разметки.
 *
 * Почему не просто useState в компоненте: здесь живут три вещи, которые
 * обязаны быть проверены тестом без браузера (в apps/web нет DOM-окружения для
 * vitest — только renderToStaticMarkup): «двойное нажатие не шлёт второй
 * запрос» (замок ставится СИНХРОННО до первого await, а не через setState,
 * который применится только на следующей отрисовке), «необратимое — только со
 * второго нажатия» и «кнопка отката исчезает сама в момент undoUntil».
 *
 * Ход: ждёт → (необратимое: «Да, безвозвратно») → выполняется → «Сделано ·
 * Отменить» → (откат) «Отменено». Плюс конечные: отменено до исполнения,
 * время вышло, не выполнено. Сервер всё равно держит «ровно один раз» сам
 * (брокер, assistantActions.ts) — замок здесь бережёт от лишнего запроса и
 * мигания, а не от двойного исполнения.
 */

export type ConfirmPhase =
  /** Ждёт решения человека. */
  | "pending"
  /** Необратимое: первое нажатие сделано, ждём «Да, безвозвратно». */
  | "arming"
  | "running"
  | "cancelling"
  /** Исполнено; откат — пока не прошёл undoUntil. */
  | "done"
  | "undoing"
  /** Отменено до исполнения. */
  | "cancelled"
  /** Исполнено и откачено. */
  | "undone"
  | "expired"
  /** Исполнить не вышло и повтор не поможет (нет доступа, данные изменились, сбой исполнителя). */
  | "failed";

export type NoticeTone = "ok" | "warn" | "crit";

export interface ConfirmCardState {
  action: AssistantActionView;
  phase: ConfirmPhase;
  /** Пояснение к смене состояния — читается экранным диктором (aria-live). */
  notice: { tone: NoticeTone; text: string } | null;
  /** Кнопку «Отменить» показывать сейчас (исполнено, у действия есть откат, срок не прошёл). */
  canUndo: boolean;
}

export interface ConfirmCardClient {
  confirm: (id: string) => Promise<AssistantActionOutcome>;
  cancel: (id: string) => Promise<AssistantActionOutcome>;
  undo: (id: string) => Promise<AssistantActionOutcome>;
}

/** Фазы, в которых идёт запрос: любые нажатия игнорируются. */
const BUSY: ReadonlySet<ConfirmPhase> = new Set(["running", "cancelling", "undoing"]);

export function phaseOf(action: AssistantActionView, now: number): ConfirmPhase {
  switch (action.status) {
    case "PENDING":
      return Date.parse(action.expiresAt) <= now ? "expired" : "pending";
    case "CONFIRMED":
      return "running";
    case "EXECUTED":
      return "done";
    case "CANCELLED":
      return "cancelled";
    case "EXPIRED":
      return "expired";
    case "UNDONE":
      return "undone";
    case "FAILED":
      return "failed";
  }
}

/**
 * Защита от двойного нажатия в одном месте экрана: после смены шага
 * («Подтвердить» → «Да, безвозвратно», «Назад» → «Отмена») следующая кнопка
 * принимает нажатие не раньше чем через это время. Двойной клик или двойной
 * Enter иначе проскакивает через оба шага разом.
 */
export const STEP_GUARD_MS = 700;

const isFuture = (iso: string | null, now: number) => iso !== null && Date.parse(iso) > now;

export class ConfirmCardController {
  private state: ConfirmCardState;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  /** Сервер сказал «откатить уже нельзя» (данные изменились, окно вышло) — кнопку больше не показываем. */
  private undoBlocked = false;
  /** Серверное время минус часы браузера (мс): сроки считаем по серверным часам, а не по неверным часам человека. */
  private skew = 0;
  /** Когда вошли в «Да, безвозвратно» (ранний confirm() игнорируется). */
  private armedAt: number | null = null;
  /** Когда вернулись из «Назад» в «ждёт» (ранняя «Отмена» игнорируется). */
  private backAt: number | null = null;
  /** Панель переносит карточку на новое действие (409 STALE) — ключи и реплики обновить на новый id. */
  onReplace: ((oldId: string, next: AssistantActionView) => void) | null = null;

  constructor(
    action: AssistantActionView,
    private readonly client: ConfirmCardClient,
    private readonly now: () => number = Date.now,
  ) {
    this.updateSkew(action);
    this.state = this.derive(action, phaseOf(action, this.clock()), null);
  }

  /** Оценка серверного «сейчас»: часы браузера + смещение от последнего события сервера. */
  private clock(): number {
    return this.now() + this.skew;
  }

  private updateSkew(action: AssistantActionView): void {
    const server = action.serverNow ? Date.parse(action.serverNow) : NaN;
    // Событие получено прямо сейчас: смещение = серверное время − часы браузера на момент получения.
    if (!Number.isNaN(server)) this.skew = server - this.now();
  }

  getState = (): ConfirmCardState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Запускает таймеры (срок подтверждения, окно отката). Вызывается из эффекта компонента. */
  start(): void {
    this.started = true;
    this.schedule();
  }

  stop(): void {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Сервер прислал то же действие ещё раз (повтор события) — принять новый статус, если он сменился и запроса нет. */
  sync(action: AssistantActionView): void {
    const current = this.state;
    if (action.id !== current.action.id || BUSY.has(current.phase) || action.status === current.action.status) return;
    this.adopt(action, null);
  }

  /** «Подтвердить». У необратимого первое нажатие только взводит «Да, безвозвратно». */
  async confirm(): Promise<void> {
    const { phase, action } = this.state;
    if (phase === "pending" && action.preview.irreversible) {
      this.armedAt = this.now();
      this.set(action, "arming", null);
      return;
    }
    if (phase !== "pending" && phase !== "arming") return;
    if (phase === "arming" && this.armedAt !== null && this.now() - this.armedAt < STEP_GUARD_MS) return;
    this.set(action, "running", null);
    try {
      const outcome = await this.client.confirm(action.id);
      this.adopt(outcome.action, outcome.action.status === "EXECUTED" ? { tone: "ok", text: "Сделано" } : null);
    } catch (err) {
      this.onConfirmError(err, action);
    }
  }

  /** «Отмена». Из «Да, безвозвратно» — просто шаг назад, без запроса. */
  async cancel(): Promise<void> {
    const { phase, action } = this.state;
    if (phase === "arming") {
      this.backAt = this.now();
      this.set(action, "pending", null);
      return;
    }
    if (phase !== "pending") return;
    if (this.backAt !== null && this.now() - this.backAt < STEP_GUARD_MS) return;
    this.set(action, "cancelling", null);
    try {
      const outcome = await this.client.cancel(action.id);
      this.adopt(outcome.action, { tone: "warn", text: "Отменено — ничего не изменилось" });
    } catch (err) {
      const e = asActionError(err);
      if (e.status === 410) return this.set(action, "expired", { tone: "warn", text: "Время вышло — попросите заново" });
      if (e.action) return this.adopt(e.action, null);
      this.set(action, "pending", { tone: "crit", text: e.message });
    }
  }

  /** «Отменить» после исполнения. */
  async undo(): Promise<void> {
    const { action } = this.state;
    if (!this.state.canUndo) return;
    this.set(action, "undoing", null);
    try {
      const outcome = await this.client.undo(action.id);
      this.adopt(outcome.action, { tone: "warn", text: "Отменено — вернули как было" });
    } catch (err) {
      const e = asActionError(err);
      if (e.status === 410 || e.status === 409 || e.status === 403) this.undoBlocked = true;
      const text =
        e.status === 410 ? "Время на отмену вышло" : e.status === 403 ? "Нет доступа" : e.message;
      this.set(action, "done", { tone: "crit", text });
    }
  }

  private onConfirmError(err: unknown, action: AssistantActionView): void {
    const e = asActionError(err);
    if (e.status === 409 && e.code === "STALE") {
      if (e.action && e.action.status === "PENDING") {
        this.onReplace?.(action.id, e.action);
        return this.set(e.action, "pending", { tone: "warn", text: "Данные изменились — проверьте новое превью" });
      }
      return this.set(action, "failed", { tone: "warn", text: "Данные изменились — попросите заново" });
    }
    if (e.status === 410) return this.set(action, "expired", { tone: "warn", text: "Время вышло — попросите заново" });
    if (e.status === 403) return this.set(action, "failed", { tone: "crit", text: "Нет доступа" });
    // Уже исполняется / уже закрыто — показываем то состояние, что прислал сервер.
    if (e.status === 409 && e.action) {
      return this.adopt(e.action, e.code === "IN_PROGRESS" ? { tone: "warn", text: "Уже выполняется" } : null);
    }
    if (e.status === 422 || e.status === 500) return this.set(action, "failed", { tone: "crit", text: e.message });
    // Сеть, таймаут, лимит — можно нажать ещё раз.
    this.set(action, "pending", { tone: "crit", text: e.message });
  }

  private adopt(action: AssistantActionView, notice: ConfirmCardState["notice"]): void {
    this.set(action, phaseOf(action, this.clock()), notice);
  }

  private derive(action: AssistantActionView, phase: ConfirmPhase, notice: ConfirmCardState["notice"]): ConfirmCardState {
    const canUndo = phase === "done" && !this.undoBlocked && isFuture(action.undoUntil, this.clock());
    return { action, phase, notice, canUndo };
  }

  private set(action: AssistantActionView, phase: ConfirmPhase, notice: ConfirmCardState["notice"]): void {
    // Новое событие сервера (другой объект) — свежая точка отсчёта; тот же объект — старая метка не годится.
    if (action !== this.state?.action) this.updateSkew(action);
    if (phase !== "pending") this.backAt = null;
    this.state = this.derive(action, phase, notice);
    for (const listener of this.listeners) listener();
    this.schedule();
  }

  /** Один таймер на ближайшую границу: срок подтверждения или конец окна отката. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.started) return;
    const { phase, action, canUndo } = this.state;
    const at =
      phase === "pending" || phase === "arming"
        ? Date.parse(action.expiresAt)
        : canUndo && action.undoUntil
          ? Date.parse(action.undoUntil)
          : null;
    if (at === null || Number.isNaN(at)) return;
    const delay = Math.max(0, at - this.clock());
    this.timer = setTimeout(() => {
      this.timer = null;
      const current = this.state;
      if (current.phase === "pending" || current.phase === "arming") {
        if (Date.parse(current.action.expiresAt) <= this.clock()) {
          this.set(current.action, "expired", { tone: "warn", text: "Время вышло — попросите заново" });
          return;
        }
      }
      // Окно отката прошло — пересчёт уберёт кнопку; уведомление прежнее.
      this.set(current.action, current.phase, current.notice);
    }, delay);
  }

  /** Для отрисовки: идёт ли запрос (кнопки заблокированы). */
  static isBusy(phase: ConfirmPhase): boolean {
    return BUSY.has(phase);
  }
}

function asActionError(err: unknown): AssistantActionRequestError {
  if (err instanceof AssistantActionRequestError) return err;
  return new AssistantActionRequestError(
    err instanceof Error ? err.message : "Не получилось — попробуйте ещё раз",
    0,
    null,
    null,
  );
}
