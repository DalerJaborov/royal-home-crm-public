import { useState } from "react";
import { Link } from "react-router-dom";
import {
  useInviteCallRecordingUrl,
  useSetVacancyStatus,
  useVacancyConversation,
  type JobApplication,
} from "../hooks/useVacancies";
import { MessageAttachments } from "./MessageAttachments";
import { MutationError } from "./MutationError";
import { VoiceNotePlayer } from "./VoiceNotePlayer";
import { api } from "../lib/api";
import { browserDeps, openPrivateFile } from "../lib/openPrivateFile";
import { useCan } from "../lib/permissions";
import {
  vacancyChatLanguageText,
  vacancyFilterReason,
  vacancyInterviewLabel,
  vacancyReceivedLabel,
} from "../lib/vacanciesView";

/**
 * Резюме — отдельная кнопка, а не общий раздел «Прислал файлами» ниже (который
 * ждёт загрузки всей переписки): это последний файл/фото, что кандидат прислал
 * за весь разговор, открывается сразу по cvFile анкеты, без похода за перепиской.
 * Тот же blob-приём, что у MessageAttachments — файл закрытый, простой <a href>
 * его не отдаст (нужен заголовок авторизации).
 *
 * 02.10.2026: окно открывается синхронно, до скачивания (lib/openPrivateFile.ts) —
 * на iPhone окно после `await` блокировалось молча, и кнопка не делала ничего.
 *
 * 02.10.2026: файл качается маршрутом раздела /vacancies/:id/cv, а не общим
 * /attachments — тот требует права на вложения переписки, которого у
 * руководителя (главного HR) нет, и резюме ему не открывалось.
 */
function CvLink({ applicationId, file }: { applicationId: string; file: string }) {
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const open = () => {
    setState("loading");
    const load = () => api<Blob>(`/vacancies/${encodeURIComponent(applicationId)}/cv`, { responseType: "blob" });
    // Без await перед вызовом: окно должно открыться в самом обработчике нажатия.
    void openPrivateFile(file, browserDeps(load)).then((ok) => setState(ok ? "idle" : "error"));
  };
  return (
    <span className="kvp">
      Резюме{" "}
      <button className="lnk" type="button" onClick={open} disabled={state === "loading"}>
        {state === "loading" ? "Открываем…" : state === "error" ? "Не открылось — повторить" : "Открыть файл"}
      </button>
    </span>
  );
}

/**
 * РАСКРЫТАЯ АНКЕТА КАНДИДАТА.
 *
 * Владелец 03.09.2026: «слишком бардачный вид карточки кандидата, я хочу
 * аккуратную карточку, где всё логично разложено, и минималистичный UI».
 *
 * ЧТО БЫЛО НЕ ТАК. Двенадцать полей рисовались сеткой всегда — и у живого
 * кандидата десять из них показывали «не спрашивали». Экран заполнялся серым
 * шумом, среди которого терялись три строки, ради которых карточку и открывают:
 * что человек рассказал, есть ли телефон и что дальше. Плюс переписка,
 * развёрнутая во всю высоту, отодвигала кнопки решения за край экрана.
 *
 * ЧТО СТАЛО. Показываем ТОЛЬКО известное, одной ровной сеткой пар «поле —
 * значение». Всё неизвестное сворачивается в одну серую строку внизу («Ещё не
 * спрашивали: возраст, город…») — это по-прежнему видно, но не занимает экран:
 * пустое поле здесь означает «бот не успел спросить», и знать это надо, а
 * смотреть на это — нет. Переписка спрятана под строку «Показать переписку»:
 * решение принимается по анкете, а лента нужна, только когда есть сомнения.
 *
 * Порядок разделов = порядок чтения: кто это → что рассказал → что прислал →
 * переписка → действия (кнопки живут снаружи, в списке).
 */

type Fact = { label: string; value: string | null };

/** «Да» / «Нет» / неизвестно — три разных состояния, и путать их нельзя: по ним
 *  сервер считает допуск (jobEligibility). */
function yesNo(value: boolean | null, yes = "Да", no = "Нет"): string | null {
  if (value === null) return null;
  return value ? yes : no;
}

/**
 * ТЕЛЕФОН — ЕДИНСТВЕННОЕ РЕДАКТИРУЕМОЕ ПОЛЕ АНКЕТЫ (добавлено 04.09.2026,
 * полный обход раздела: «зайди глубоко в код, ищи баги»).
 *
 * Раньше правки не было НИГДЕ: бот записал криво (а до соседней правки —
 * lib/candidatePhone.ts — он мог записать вообще любую строку, хоть «оставлю
 * попозже») — и исправить было нечем, кроме как ждать, пока кандидат снова
 * напишет боту сам. У остальных полей анкеты это не так критично: телефон —
 * единственное поле, от которого зависит, увидит ли руководство кандидата в
 * очереди вообще (HAS_PHONE в routes/vacancies.ts). Своя строка, а не общий
 * список фактов: только у него есть кнопка «Изменить» и своё состояние формы.
 */
function PhoneField({ item }: { item: JobApplication }) {
  const setStatus = useSetVacancyStatus();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.phone ?? "");

  if (!editing) {
    return (
      <span className="kvp">
        Телефон{" "}
        {item.phone ? (
          // Номер — просто текст: звонок только кнопкой «Позвонить» (через
          // станцию), а не ссылкой tel: с личного телефона (29.09.2026).
          <b>{item.phone}</b>
        ) : (
          <b>ещё не дал</b>
        )}
        <button
          className="lnk"
          type="button"
          onClick={() => {
            setDraft(item.phone ?? "");
            setEditing(true);
          }}
          aria-label={item.phone ? "Изменить телефон" : "Указать телефон"}
        >
          Изменить
        </button>
      </span>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, gridColumn: "1 / -1" }}>
      <label className="fld">
        <span className="lab">Телефон</span>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="+992 90 011 22 33" autoFocus />
      </label>
      <span className="wrap">
        <button
          className="pill sm"
          type="button"
          disabled={setStatus.isPending}
          onClick={() => setStatus.mutate({ id: item.id, phone: draft.trim() || null }, { onSuccess: () => setEditing(false) })}
        >
          Сохранить
        </button>
        <button className="pill ghost sm" type="button" disabled={setStatus.isPending} onClick={() => setEditing(false)}>
          Отмена
        </button>
      </span>
      <MutationError mutation={setStatus} fallback="Не удалось сохранить телефон" />
    </div>
  );
}

export function VacancyDetails({ item }: { item: JobApplication }) {
  const [showChat, setShowChat] = useState(false);
  // Ссылка в «Сообщения» — только тому, кому раздел открыт (02.10.2026):
  // иначе она вела на экран «нет доступа».
  const can = useCan();
  const canOpenInbox = can("messages.view") || can("messages.viewOwn");
  // Переписка и вложения грузятся, только когда анкету раскрыли: список из
  // двадцати кандидатов не должен тянуть двадцать переписок.
  const { data, isLoading, isError, refetch } = useVacancyConversation(item.id);
  const files = data?.files ?? [];
  const messages = data?.messages ?? [];
  // «Всё, что он сказал» (владелец 25.09.2026) — слова самого кандидата подряд,
  // без реплик бота. Раньше здесь стоял rawText: склейка пересказов модели за
  // каждый ход, с повторами и обрывками.
  const saidLines = messages
    .filter((m) => m.role === "user")
    .map((m) => m.content.trim())
    .filter(Boolean);
  const reason = vacancyFilterReason(item);

  // Телефон — своя строка с кнопкой правки (см. PhoneField), поэтому в общий
  // список фактов «известно/не спрашивали» он не попадает: дублировать поле
  // с кнопкой и без было бы ровно той же путаницей, что владелец уже просил
  // убрать («всё в перемешку»).
  const facts: Fact[] = [
    { label: "Имя", value: item.name ?? item.contactName },
    { label: "Возраст", value: item.age !== null ? `${item.age}` : null },
    { label: "Город", value: item.city },
    { label: "Работает сейчас", value: yesNo(item.employedNow) },
    { label: "Учится сейчас", value: yesNo(item.studyingNow) },
    { label: "Учится в вузе", value: yesNo(item.studyingUniversity) },
    { label: "Опыт", value: item.experience },
    { label: "Опыт в продажах", value: yesNo(item.salesExperience ?? null) },
    { label: "Образование", value: item.education },
    { label: "Диплом по нужной специальности", value: yesNo(item.targetEducation ?? null) },
    { label: "Языки", value: item.languages },
    { label: "Машина", value: yesNo(item.hasCar, "Есть", "Нет") },
    { label: "Сильное желание работать", value: yesNo(item.strongMotivation ?? null) },
    { label: "Достижения", value: item.achievements ?? null },
    { label: "Готов начать", value: item.startWhen },
  ];
  const known = facts.filter((f) => f.value);
  const unknown = facts.filter((f) => !f.value).map((f) => f.label.toLowerCase());

  return (
    <div className="card flat" style={{ margin: "0 0 12px" }}>
      {/* РЕЗЮМЕ (владелец 25.09.2026: «нажал на карточку — и аккуратно всё про
          этого человека написано»). Сверху то, по чему решают и звонят: номер,
          язык переписки, резюме-файл; ниже столбиком всё известное о человеке. */}
      <div className="sec-t">Резюме</div>
      <div className="kvp" style={{ gap: "var(--s4)" }}>
        <PhoneField item={item} />
        {item.chatLanguage && (
          <span className="kvp">
            Язык переписки: <b>{vacancyChatLanguageText(item.chatLanguage)}</b>
          </span>
        )}
        {item.cvFile && <CvLink applicationId={item.id} file={item.cvFile} />}
      </div>
      {known.length > 0 && (
        <dl className="list" style={{ margin: 0 }}>
          {known.map((f) => (
            <div className="row" key={f.label}>
              <dt className="state" style={{ margin: 0 }}>
                {f.label}
              </dt>
              <dd style={{ margin: 0, whiteSpace: "pre-wrap" }}>
                <b>{f.value}</b>
              </dd>
            </div>
          ))}
        </dl>
      )}
      {item.priorityReason && <p className="state">Оценка: {item.priorityReason}.</p>}

      {unknown.length > 0 && (
        /* Одной строкой вместо десяти пустых полей: знать, чего бот не спросил,
           надо, а разглядывать это нет. */
        <p className="state">Ещё не спрашивали: {unknown.join(", ")}.</p>
      )}

      {reason &&
        (item.eligibleOverride ? (
          /* «Всё равно позвать» (02.10.2026): причина отбора остаётся видна, но
             решение уже принято — спокойным тоном, не красным. */
          <div className="quiet">
            <span className="dot" />
            <span className="txt">Не прошёл обязательный отбор: {reason}. Взят в работу вопреки отбору.</span>
          </div>
        ) : (
          <div className="quiet crit">
            <span className="dot crit" />
            <span className="txt">Не прошёл обязательный отбор: {reason}.</span>
          </div>
        ))}

      {item.status === "INTERVIEW" && item.interviewAt && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">Собеседование {vacancyInterviewLabel(item.interviewAt)}</span>
        </div>
      )}
      {item.inviteCall && (
        /* Итог робота-приглашения (25.09.2026): «придёт» спокойным тоном,
           всё остальное — вниманию HR. */
        <div className={item.inviteCall.outcome === "CONFIRMED" ? "quiet" : "quiet warn"}>
          <span className={item.inviteCall.outcome === "CONFIRMED" ? "dot" : "dot warn"} />
          <span className="txt">
            {item.inviteCall.text}
            {item.inviteCall.summary ? `. ${item.inviteCall.summary}` : ""}
          </span>
        </div>
      )}
      {item.inviteCall?.hasRecording && <InviteCallRecording applicationId={item.id} />}
      {item.interviewNote && (
        <p className="state">Заметка: {item.interviewNote}</p>
      )}
      {item.rejectionReason && <p className="state">Причина отказа: {item.rejectionReason}</p>}
      {item.rejectionReasonVoiceUrl && <VoiceNotePlayer url={item.rejectionReasonVoiceUrl} />}

      {saidLines.length > 0 ? (
        <>
          <div className="sec-t">Что рассказал сам</div>
          <ul className="list" style={{ margin: 0 }}>
            {saidLines.map((line, i) => (
              <li className="row" key={i} style={{ whiteSpace: "pre-wrap" }}>
                {line}
              </li>
            ))}
          </ul>
        </>
      ) : (
        item.rawText &&
        !isLoading && (
          <>
            <div className="sec-t">Что рассказал сам</div>
            <p style={{ whiteSpace: "pre-wrap" }}>{item.rawText}</p>
          </>
        )
      )}

      {/* Файлы: резюме, диплом, фото документа. В полях анкеты их нет никогда:
          модель кладёт туда только слова. Блока нет, когда прислать нечего. */}
      {(isLoading || isError || files.length > 0) && (
        <>
          <div className="sec-t">Прислал файлами</div>
          {isLoading ? (
            <div className="state">
              <span className="sk w28" /> Загружаем вложения
            </div>
          ) : isError ? (
            <div className="state err">
              <span className="dot crit" /> Вложения не загрузились.{" "}
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => refetch()}
              >
                Повторить
              </button>
            </div>
          ) : (
            <MessageAttachments attachments={files} />
          )}
        </>
      )}

      {/* Переписка под строкой, а не развёрнута: она длинная и отодвигала
          решение за край экрана. */}
      <div className="wrap">
        {messages.length > 0 && (
          <button className="lnk" type="button" aria-expanded={showChat} onClick={() => setShowChat((v) => !v)}>
            {showChat ? "Скрыть переписку" : `Показать всю переписку (${messages.length})`}
          </button>
        )}
        {item.inboxId ? (
          canOpenInbox && (
            <Link className="lnk" to={`/messages?open=${encodeURIComponent(item.inboxId)}`}>
              Ответить в «Сообщениях»
            </Link>
          )
        ) : (
          <span className="state">Переписка не сохранилась</span>
        )}
        <span className="state">Анкета: {vacancyReceivedLabel(item.createdAt)}</span>
      </div>

      {showChat && messages.length > 0 && (
        <div className="thread" style={{ maxHeight: 420, borderRadius: "var(--r-md)" }}>
          {messages.map((m, i) => (
            <div className={m.role === "user" ? "bub" : "bub bot"} key={i}>
              <span className="who">{m.role === "user" ? "Кандидат" : "Бот"}</span>
              <span style={{ whiteSpace: "pre-wrap" }}>{m.content}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Запись разговора робота с кандидатом (проверка робота 02.10.2026: анкета
 * говорила «послушайте разговор», а послушать было негде). Видимый плеер, а
 * не невидимый звук: у разговора в несколько минут нужны пауза и перемотка.
 */
function InviteCallRecording({ applicationId }: { applicationId: string }) {
  const recording = useInviteCallRecordingUrl();
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (url) {
    return (
      <div className="quiet">
        <audio controls autoPlay preload="none" src={url} style={{ height: 34, maxWidth: 260, flex: 1 }} />
      </div>
    );
  }
  return (
    <div className="quiet">
      <button
        className="lnk"
        type="button"
        disabled={recording.isPending}
        onClick={() => {
          setFailed(false);
          recording.mutate(applicationId, { onSuccess: (r) => setUrl(r.url), onError: () => setFailed(true) });
        }}
      >
        {recording.isPending ? "Загружаю запись…" : "Послушать разговор"}
      </button>
      {failed && <span className="txt"> Запись не открылась — попробуйте ещё раз.</span>}
    </div>
  );
}
