import { useState } from "react";
import { CalendarCheck, Home } from "lucide-react";
import { Link } from "react-router-dom";
import { defaultShowingCallbackLocal, dushanbeLocalToIso, isoToDushanbeLocal, SHOWING_NEXT_STEP_LABELS, SHOWING_NEXT_STEPS, type ShowingNextStep, type ShowingQuestionView } from "@royal-home/shared";
import { useAnswerShowingQuestion, useShowingQuestions } from "../hooks/useShowingQuestions";
import { dushanbeDateTime } from "../lib/date";
import { formatPropertyCode } from "../lib/clientFormat";
import { AddInteractionModal } from "./AddInteractionModal";
import { MutationError } from "./MutationError";
import { RuDateTimeField } from "./look/fields/RuFields";

/**
 * «У ВАС БЫЛ ПОКАЗ?» И «ДОГОВОРИЛИСЬ О ПОКАЗЕ?» В CRM (владелец 22.11.2026).
 *
 * Главный путь — кнопки в Шабнам («там люди охотнее нажимают кнопку»). Здесь тот же
 * вопрос карточкой — для тех, у кого нет Telegram или кто не ответил там. Карточка
 * НЕ блокирует экран: обязательные окна владелец уже отменял («достало»). Ответ здесь
 * снимает кнопки в Шабнам и наоборот — одна серверная дверь.
 *
 * Один компонент на ПК и телефон: Главная (AppLayout, все вопросы агента) и карточка
 * клиента (ClientDetail и MobileClientCard — вопросы этого клиента).
 */

const BTN = "glass-btn tap-target min-h-[44px] px-4 py-2 text-[15px]";
const PRIMARY = `${BTN} glass-btn-primary`;
const GHOST = `${BTN} glass-btn-ghost`;

/** ISO → значение поля «дата и время» по Душанбе (общая пара с разбором — @royal-home/shared). */
function toDushanbeLocal(iso: string | null): string {
  return iso ? isoToDushanbeLocal(iso) : "";
}

const fromDushanbeLocal = dushanbeLocalToIso;

export function ShowingQuestionsPanel({ clientId }: { clientId?: string }) {
  const questions = useShowingQuestions(clientId);
  // Не загрузилось — карточки просто нет: главный путь ответа — кнопки в Шабнам, а пуш
  // о вопросе уже пришёл. Следующая попытка — через минуту (refetchInterval).
  if (questions.isError) return null;
  const items = questions.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <section aria-label="Вопросы о показах" className="mb-4 flex w-full max-w-2xl flex-col gap-3">
      {items.map((q) => (
        <ShowingQuestionCard key={q.id} q={q} showClient={!clientId} />
      ))}
    </section>
  );
}

function ShowingQuestionCard({ q, showClient }: { q: ShowingQuestionView; showClient: boolean }) {
  const answer = useAnswerShowingQuestion();
  const [step, setStep] = useState<"ask" | "held" | "notHeld" | "callback" | "reschedule" | "cancel">("ask");
  const [when, setWhen] = useState(() => toDushanbeLocal(q.at));
  const [callbackAt, setCallbackAt] = useState(() => defaultShowingCallbackLocal());
  const [reason, setReason] = useState("");
  const [propertyId, setPropertyId] = useState<string | null>(q.property?.id ?? (q.options.length === 1 ? q.options[0].id : null));
  const [done, setDone] = useState<string | null>(null);
  const [bookOpen, setBookOpen] = useState(false);

  const send = (body: Parameters<typeof answer.mutate>[0]["answer"]) =>
    answer.mutate({ id: q.id, answer: body }, { onSuccess: (r) => setDone(r.message) });

  const title = q.kind === "OUTCOME" ? "У вас был показ?" : "Договорились о показе?";
  const what = [q.property ? `${formatPropertyCode(q.property.shortId)} · ${q.property.title}` : null, q.at ? dushanbeDateTime(q.at) : null]
    .filter(Boolean)
    .join(", ");

  const bookModal = bookOpen && (
    <AddInteractionModal
      clientId={q.clientId}
      initialType="SHOWING"
      mode="schedule"
      onClose={() => setBookOpen(false)}
      // Показ записан формой — вопрос сервер снимет сам (у клиента появился показ).
      onSaved={() => {
        setBookOpen(false);
        setDone((prev) => prev ?? "Показ записан");
      }}
    />
  );

  if (done) {
    return (
      <div className="glass-notice p-4" role="status">
        <p className="text-[15px] text-ink">{done}</p>
        {bookModal}
      </div>
    );
  }

  return (
    <div className="glass-notice glass-notice-enter p-4">
      <div className="flex items-start gap-2.5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-[13px] bg-blue/10 text-blue" aria-hidden>
          {q.kind === "OUTCOME" ? <Home className="h-4 w-4" /> : <CalendarCheck className="h-4 w-4" />}
        </span>
        <div className="min-w-0 flex-1">
          {/* Сам вопрос — крупно: на него и отвечают. */}
          <h2 className="text-[19px] font-semibold leading-tight text-ink">{title}</h2>
          <p className="mt-0.5 text-[15px] text-gray-500">
            {showClient ? (
              <Link to={`/clients/${q.clientShortId}`} className="font-medium text-blue hover:underline">
                {q.clientName}
              </Link>
            ) : null}
            {showClient && what ? " · " : null}
            {what || (q.kind === "AGREEMENT" ? "Время и объект ИИ не понял" : null)}
          </p>
          {q.quote && <p className="mt-1 text-[14px] italic text-gray-500">«{q.quote}»</p>}
        </div>
      </div>

      {q.kind === "OUTCOME" && step === "ask" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={PRIMARY} onClick={() => setStep("held")}>Да, был</button>
          <button type="button" className={GHOST} onClick={() => setStep("notHeld")}>Нет</button>
        </div>
      )}

      {q.kind === "OUTCOME" && step === "held" && (
        <div className="mt-3">
          <p className="text-[15px] font-medium text-ink">Что дальше с клиентом?</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {SHOWING_NEXT_STEPS.map((next: ShowingNextStep) => (
              <button
                key={next}
                type="button"
                disabled={answer.isPending}
                className={GHOST}
                onClick={() => {
                  if (next === "callback") return setStep("callback");
                  // «Ещё показ» — отметить этот и сразу открыть форму нового показа.
                  send({ action: "held", next });
                  if (next === "another_showing") setBookOpen(true);
                }}
              >
                {SHOWING_NEXT_STEP_LABELS[next]}
              </button>
            ))}
          </div>
        </div>
      )}

      {q.kind === "OUTCOME" && step === "callback" && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[14px] text-gray-500">
            Когда перезвонить
            <RuDateTimeField value={callbackAt} onChange={(e) => setCallbackAt(e.target.value)} className="mt-1 min-h-[44px] rounded-control border border-line px-3 text-[16px]" />
          </label>
          <button
            type="button"
            className={PRIMARY}
            disabled={answer.isPending || !fromDushanbeLocal(callbackAt)}
            onClick={() => send({ action: "held", next: "callback", callbackAt: fromDushanbeLocal(callbackAt)! })}
          >
            Сохранить
          </button>
        </div>
      )}

      {q.kind === "OUTCOME" && step === "notHeld" && (
        <div className="mt-3 flex flex-wrap gap-2">
          <button type="button" className={GHOST} onClick={() => setStep("reschedule")}>Перенесли</button>
          <button type="button" className={GHOST} onClick={() => setStep("cancel")}>Отменили</button>
        </div>
      )}

      {q.kind === "OUTCOME" && step === "reschedule" && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex flex-col text-[14px] text-gray-500">
            Новое время показа
            <RuDateTimeField value={when} onChange={(e) => setWhen(e.target.value)} className="mt-1 min-h-[44px] rounded-control border border-line px-3 text-[16px]" />
          </label>
          <button type="button" className={PRIMARY} disabled={answer.isPending || !fromDushanbeLocal(when)} onClick={() => send({ action: "reschedule", at: fromDushanbeLocal(when)! })}>
            Перенести
          </button>
        </div>
      )}

      {q.kind === "OUTCOME" && step === "cancel" && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <label className="flex min-w-[220px] flex-1 flex-col text-[14px] text-gray-500">
            Почему отменили
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Например: клиент передумал" className="mt-1 min-h-[44px] rounded-control border border-line px-3 text-[16px]" />
          </label>
          <button type="button" className={PRIMARY} disabled={answer.isPending || reason.trim().length < 3} onClick={() => send({ action: "cancelled", reason: reason.trim() })}>
            Сохранить
          </button>
        </div>
      )}

      {q.kind === "AGREEMENT" && (
        <div className="mt-3 flex flex-col gap-2">
          {!q.property && q.options.length > 1 && (
            <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Какой объект">
              {q.options.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="radio"
                  aria-checked={propertyId === o.id}
                  className={propertyId === o.id ? PRIMARY : GHOST}
                  onClick={() => setPropertyId(o.id)}
                >
                  {formatPropertyCode(o.shortId)} · {o.title}
                </button>
              ))}
            </div>
          )}
          {!q.property && q.options.length === 1 && (
            <p className="text-[15px] text-gray-500">Объект: {formatPropertyCode(q.options[0].shortId)} · {q.options[0].title}</p>
          )}
          <label className="flex flex-col text-[14px] text-gray-500 sm:max-w-[260px]">
            Время показа
            <RuDateTimeField value={when} onChange={(e) => setWhen(e.target.value)} className="mt-1 min-h-[44px] rounded-control border border-line px-3 text-[16px]" />
          </label>
          <div className="flex flex-wrap gap-2">
            {propertyId ? (
              <button
                type="button"
                className={PRIMARY}
                disabled={answer.isPending || !fromDushanbeLocal(when)}
                onClick={() => send({ action: "book", propertyId, at: fromDushanbeLocal(when)! })}
              >
                Да, записать показ
              </button>
            ) : (
              // Объект не понят и подбор пуст — та же форма показа, что в карточке клиента.
              <button type="button" className={PRIMARY} onClick={() => setBookOpen(true)}>
                Да, выбрать объект
              </button>
            )}
            <button type="button" className={GHOST} disabled={answer.isPending} onClick={() => send({ action: "no" })}>
              Нет, не договорились
            </button>
          </div>
        </div>
      )}

      <MutationError mutation={answer} fallback="Не удалось сохранить ответ" className="mt-2" />
      {bookModal}
    </div>
  );
}
