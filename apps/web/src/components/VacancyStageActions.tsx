import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useSetVacancyStatus, type JobApplication } from "../hooks/useVacancies";
import { MutationError } from "./MutationError";
import {
  VACANCY_ACTIONS_NOTE,
  VACANCY_ACTION_HINT,
  interviewInputToIso,
  interviewIsoToInput,
  inviteCallNoteToShow,
} from "../lib/vacanciesView";
import { toast } from "../store/toast";
import { VoiceNoteButton, type VoiceNote } from "./VoiceNoteButton";

/**
 * Кнопки перехода по воронке — используются строкой кандидата (VacancyRow) и
 * карточкой «Сегодня» на экране `pages/Vacancies.tsx` (один экран на обе
 * ширины), вынесены отдельно, чтобы логика перехода стадий не разошлась
 * между двумя местами вызова.
 *
 * ОБЛИК: классы прототипа темы «Royal Home 2026» (`.pill`, `.pill.ghost.sm`,
 * `.lnk`, `.fld`, `.state`) — в макете vacancies.html действия кандидата живут
 * ровно так: `.pill.ghost.sm` на шаг вперёд и `.lnk` на отказ или перенос.
 *
 * ПОЧЕМУ НЕ ПРОСТО СПИСОК КНОПОК СТАТУСОВ (было раньше, до 31.08.2026): стадия
 * INTERVIEW без даты ничего не говорит руководству, что и когда делать дальше
 * (правило владельца), переход в неё поэтому открывает форму с датой, а не
 * меняет статус одним кликом.
 *
 * ОТКАЗ, НАОБОРОТ, В ОДНО НАЖАТИЕ (владелец 03.09.2026: «причину текстом или
 * голосовым, необязательно, сделай вообще, чтобы не было сложностей с ними»).
 * Причина осталась полем карточки и дописывается по желанию уже после отказа.
 *
 * `compact` — для строки `.solve` («Сегодня»): только решающие кнопки, без
 * пояснительной строки под ними, потому что она уже есть в разделе ниже.
 */
export function VacancyStageActions({
  item,
  compact = false,
  formHost = null,
}: {
  item: JobApplication;
  compact?: boolean;
  /**
   * Куда рисовать открытую форму (дата собеседования, заметка, причина отказа).
   * Строка кандидата отдаёт сюда полосу ПОД собой (28.09.2026): форма внутри
   * колонки кнопок `.act` (flex:none) раздувала её до ширины формы, и имя,
   * чипы проверок и «Позвонить» сжимались в щель и наезжали друг на друга.
   * Без хоста форма остаётся на месте кнопок, как в строке «Сегодня».
   */
  formHost?: HTMLElement | null;
}) {
  const setStatus = useSetVacancyStatus();
  const [mode, setMode] = useState<"idle" | "interview" | "reject" | "note">("idle");
  const [interviewAt, setInterviewAt] = useState("");
  // Робот зовёт кандидата сам (владелец 25.09.2026) — по умолчанию включено,
  // если есть номер: ради этого кнопку и жмут.
  const [inviteCall, setInviteCall] = useState(true);
  const [interviewNote, setInterviewNoteDraft] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [rejectionVoiceNote, setRejectionVoiceNote] = useState<VoiceNote | null>(null);
  const busy = setStatus.isPending;

  /**
   * НАЙДЕНО 04.09.2026 (полный обход раздела): «Перенести» открывало ПУСТУЮ
   * форму, а не текущую дату собеседования. Для назначения впервые пустое поле
   * правильное умолчание, но перенос по смыслу это ПРАВКА уже назначенного
   * времени, и оно обязано быть на месте.
   *
   * 02.10.2026: поле заполняется и читается по ДУШАНБЕ (interviewIsoToInput /
   * interviewInputToIso), а не по часам браузера — иначе владелец за границей
   * назначал 14:00, а робот звал кандидата на 16:00. Галочка робота каждый раз
   * открывается заново (есть номер — включена): иначе снятая однажды галочка
   * тихо переезжала на следующего кандидата.
   */
  function openInterviewForm() {
    setInterviewAt(item.interviewAt ? interviewIsoToInput(item.interviewAt) : "");
    setInviteCall(!!item.phone);
    setMode("interview");
  }

  function openNoteForm() {
    setInterviewNoteDraft(item.interviewNote ?? "");
    setMode("note");
  }

  const toIso = interviewInputToIso;

  /** Форма занимает свою строку целиком: в `.act` она встала бы в узкую колонку. */
  const formStyle = { flex: "1 1 100%", minWidth: 220, display: "flex", flexDirection: "column" as const, gap: 8 };
  const place = (form: ReactNode) =>
    // flex 100% — для хоста внутри `.solve` («Сегодня», display:contents):
    // там обёртка становится элементом гибкой строки и уходит на свою строку
    // под текстом и кнопками. В блочной полосе `.row-form` это свойство ничего не делает.
    formHost
      ? createPortal(<div style={{ padding: "4px 0 14px", flex: "1 1 100%", minWidth: 0 }}>{form}</div>, formHost)
      : form;

  if (mode === "interview") {
    return place(
      <div style={formStyle}>
        <label className="fld">
          <span className="lab">Дата и время собеседования</span>
          {/* min — «сейчас» по Душанбе: робот зовёт только на будущее время,
              и прошедшее сервер всё равно отклонит. */}
          <input
            type="datetime-local"
            value={interviewAt}
            min={interviewIsoToInput(new Date())}
            onChange={(e) => setInterviewAt(e.target.value)}
          />
        </label>
        {item.phone ? (
          <label className="wrap" style={{ gap: 8, alignItems: "center" }}>
            <input type="checkbox" checked={inviteCall} onChange={(e) => setInviteCall(e.target.checked)} />
            <span>Робот позвонит и пригласит</span>
          </label>
        ) : (
          <p className="state">Номера нет, робот позвонить не сможет.</p>
        )}
        <span className="wrap">
          <button
            className="pill sm"
            type="button"
            disabled={busy || !toIso(interviewAt)}
            onClick={() => {
              const iso = toIso(interviewAt);
              if (!iso) return;
              setStatus.mutate(
                { id: item.id, status: "INTERVIEW", interviewAt: iso, ...(inviteCall && item.phone ? { inviteCall: true } : {}) },
                {
                  onSuccess: (response) => {
                    setMode("idle");
                    // Собеседование сохранено, а звонок робот не поставил — сказать
                    // причину словами сервера. Всплывашкой, а не строкой в форме:
                    // строка кандидата после сохранения переезжает в другую секцию
                    // и рисуется заново, состояние формы там не доживает.
                    const note = inviteCallNoteToShow(response);
                    if (note) toast.error(note);
                  },
                }
              );
            }}
          >
            Назначить
          </button>
          <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setMode("idle")}>
            Отмена
          </button>
        </span>
        <p className="state">{VACANCY_ACTION_HINT.interviewForm}</p>
        <MutationError mutation={setStatus} fallback="Не удалось назначить собеседование" />
      </div>
    );
  }

  if (mode === "note") {
    /**
     * ДОБАВЛЕНО 04.09.2026: поле `interviewNote` было проведено через всю
     * цепочку (схема БД, PATCH, тип, показ в VacancyDetails), а написать в него
     * было НЕЧЕМ — ни одной формы нигде.
     */
    return place(
      <div style={formStyle}>
        <label className="fld">
          <span className="lab">Заметка по итогам</span>
          <textarea
            value={interviewNote}
            onChange={(e) => setInterviewNoteDraft(e.target.value)}
            rows={3}
            placeholder="Впечатление, сильные и слабые стороны: по желанию, для себя"
          />
        </label>
        <span className="wrap">
          <button
            className="pill sm"
            type="button"
            disabled={busy}
            onClick={() =>
              setStatus.mutate({ id: item.id, interviewNote: interviewNote.trim() || null }, { onSuccess: () => setMode("idle") })
            }
          >
            Сохранить
          </button>
          <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setMode("idle")}>
            Отмена
          </button>
        </span>
        <MutationError mutation={setStatus} fallback="Не удалось сохранить заметку" />
      </div>
    );
  }

  if (mode === "reject") {
    return place(
      <div style={formStyle}>
        <label className="fld">
          <span className="lab">Причина отказа</span>
          <textarea
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            rows={2}
            placeholder="По желанию, для себя"
          />
        </label>
        <VoiceNoteButton uploadUrl="/me/voice-notes" value={rejectionVoiceNote} onChange={setRejectionVoiceNote} />
        <span className="wrap">
          <button
            className="pill sm"
            type="button"
            disabled={busy}
            onClick={() =>
              setStatus.mutate(
                {
                  id: item.id,
                  // Статус здесь не трогаем: анкета уже в отказе, форма
                  // открывается только с её строки.
                  rejectionReason: rejectionReason.trim() || null,
                  ...(rejectionVoiceNote
                    ? {
                        rejectionReasonVoiceUrl: rejectionVoiceNote.url,
                        rejectionReasonVoiceTranscript: rejectionVoiceNote.transcript,
                      }
                    : {}),
                },
                { onSuccess: () => setMode("idle") }
              )
            }
          >
            Сохранить
          </button>
          <button className="pill ghost sm" type="button" disabled={busy} onClick={() => setMode("idle")}>
            Отмена
          </button>
        </span>
        <p className="state">{VACANCY_ACTION_HINT.rejectForm}</p>
        <MutationError mutation={setStatus} fallback="Не удалось сохранить причину" />
      </div>
    );
  }

  // Терминальные стадии: своя короткая обвязка вместо общего набора кнопок.
  // HIRED дальше никуда не идёт, REJECTED это только пометка резерва или отмена.
  if (item.status === "HIRED") return null;

  if (item.status === "REJECTED") {
    return (
      <>
        <label className="chip" title={VACANCY_ACTION_HINT.talentPool}>
          <input
            type="checkbox"
            checked={item.talentPool}
            disabled={busy}
            onChange={(e) => setStatus.mutate({ id: item.id, talentPool: e.target.checked })}
          />
          Кадровый резерв
        </label>
        {/* Причина по желанию и ПОСЛЕ отказа, а не преградой перед ним. */}
        <button
          className="lnk"
          type="button"
          disabled={busy}
          title={VACANCY_ACTION_HINT.rejectReason}
          onClick={() => {
            setRejectionReason(item.rejectionReason ?? "");
            setMode("reject");
          }}
        >
          {item.rejectionReason || item.rejectionReasonVoiceUrl ? "Изменить причину" : "Добавить причину"}
        </button>
        <button
          className="pill ghost sm"
          type="button"
          disabled={busy}
          title={VACANCY_ACTION_HINT.undoReject}
          onClick={() => setStatus.mutate({ id: item.id, status: "REVIEWED" })}
        >
          Отменить отказ
        </button>
      </>
    );
  }

  return (
    <>
      {item.status === "NEW" && (
        <button
          className="pill ghost sm"
          type="button"
          disabled={busy}
          title={VACANCY_ACTION_HINT.reviewed}
          onClick={() => setStatus.mutate({ id: item.id, status: "REVIEWED" })}
        >
          Просмотрена
        </button>
      )}
      {(item.status === "NEW" || item.status === "REVIEWED") && (
        <button
          className={compact ? "pill sm" : "pill ghost sm"}
          type="button"
          disabled={busy}
          title={VACANCY_ACTION_HINT.interview}
          onClick={openInterviewForm}
        >
          Собеседование
        </button>
      )}
      {item.status === "INTERVIEW" && (
        <>
          <button
            className={compact ? "pill sm" : "pill ghost sm"}
            type="button"
            disabled={busy}
            title={VACANCY_ACTION_HINT.interviewed}
            onClick={() => setStatus.mutate({ id: item.id, status: "INTERVIEWED" })}
          >
            Провели
          </button>
          <button className="lnk" type="button" disabled={busy} title={VACANCY_ACTION_HINT.interviewMove} onClick={openInterviewForm}>
            Перенести
          </button>
        </>
      )}
      {item.status === "INTERVIEWED" && (
        <button
          className={compact ? "pill sm" : "pill ghost sm"}
          type="button"
          disabled={busy}
          title={VACANCY_ACTION_HINT.hired}
          onClick={() => setStatus.mutate({ id: item.id, status: "HIRED" })}
        >
          Принять на работу
        </button>
      )}
      {/* Заметка по итогам только там, где уже есть что оценивать. */}
      {!compact && (item.status === "INTERVIEW" || item.status === "INTERVIEWED") && (
        <button className="lnk" type="button" disabled={busy} title={VACANCY_ACTION_HINT.interviewNote} onClick={openNoteForm}>
          {item.interviewNote ? "Изменить заметку" : "Добавить заметку"}
        </button>
      )}
      {!compact && (
        <button
          className="lnk"
          type="button"
          disabled={busy}
          title={`${VACANCY_ACTION_HINT.reject} ${VACANCY_ACTIONS_NOTE}`}
          onClick={() => setStatus.mutate({ id: item.id, status: "REJECTED" })}
        >
          Отказ
        </button>
      )}
    </>
  );
}
