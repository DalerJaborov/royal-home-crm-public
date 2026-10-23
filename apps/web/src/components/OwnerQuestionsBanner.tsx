import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, HelpCircle, Home, MessageCircle } from "lucide-react";
import { Link } from "react-router-dom";
import { useAnswerOwnerQuestion, useOwnerQuestions } from "../hooks/useMe";
import { useCan } from "../lib/permissions";
import { formatMoney, relativeTime } from "../lib/format";
import { formatPropertyCode } from "../lib/clientFormat";
import { MutationError } from "./MutationError";
import type { Currency } from "@royal-home/shared";
import { Rh2Inline } from "./rh2/Rh2Scope";

/**
 * «Уточню у собственника» — обещания бота, которые ждут живого человека.
 *
 * ТОЛЬКО ДЛЯ АДМИНИСТРАТИВНОЙ ЧАСТИ (владелец 05.08.2026 — пересмотрел прежнее
 * решение). Раньше баннер был виден всем сотрудникам («обещание от имени компании,
 * ответить может тот, кто первым дозвонился собственнику»), но на практике рядовые
 * агенты видели чужие вопросы без контекста и это только путало. Право
 * `dashboard.analytics` переиспользовано как маркер «руководящая часть» — им уже
 * по умолчанию владеют DIRECTOR/ADMIN/MANAGER, заводить отдельное право под один
 * баннер незачем.
 *
 * Ответ уходит клиенту САМ, кнопкой «Ответить клиенту» — и это принципиально.
 * Ровно на разделении «отметил в CRM» и «клиент получил» уже обожглись с кнопкой
 * «Предложить объект»: владелец видел пометку и был уверен, что ссылка ушла, а
 * клиент не получал ничего.
 *
 * ПЕРЕСОБРАН 13.08.2026 по разбору владельца на живом вопросе: «не видно, что за
 * квартира, что за вопрос, контекста нет, не открывается чат, очереди не видно,
 * слишком широкое окно». Было: текст вопроса, имя клиента и поле ввода во всю
 * ширину экрана — отвечать по такому нельзя, не открыв вручную две карточки.
 * Стало: карточка объекта с фото и ценой, ссылки в переписку и на объект,
 * переключение очереди и заготовки ответа в одно нажатие.
 */

/**
 * Заготовки ответа. Нажатие ПОДСТАВЛЯЕТ текст в поле, а не отправляет его:
 * ответ уходит клиенту как есть, и отправлять его мимо глаз человека нельзя.
 *
 * Набор короткий и про то, что спрашивают чаще всего — судьбу и цену объекта.
 * Длинный список заготовок читается дольше, чем печатается ответ, и смысл теряется.
 */
const QUICK_ANSWERS = ["Ещё продаётся", "Уже продана", "Цена прежняя", "Цена изменилась"];

export function OwnerQuestionsBanner() {
  const can = useCan();
  const { data } = useOwnerQuestions({ enabled: can("dashboard.analytics") });
  const answer = useAnswerOwnerQuestion();
  const [text, setText] = useState("");
  const [textTarget, setTextTarget] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  /** Какой вопрос очереди открыт. Очередь была невидимой: показывался первый, а
   *  остальные существовали только числом «ещё 2». */
  const [index, setIndex] = useState(0);

  const items = data?.items ?? [];
  // Очередь укоротилась (ответили из другой вкладки) — не показываем пустоту на
  // месте выбранного вопроса. Хук вызывается до раннего возврата: правила хуков.
  useEffect(() => {
    if (index > 0 && index >= items.length) setIndex(0);
  }, [index, items.length]);

  if (!can("dashboard.analytics")) return null;
  const current = items[Math.min(index, Math.max(0, items.length - 1))];
  if (!current) return null;
  const managed = current.managedRevision != null;
  const answeredHeld = managed && current.answeredAt != null;
  const editorKey = `${current.id}:${current.managedRevision ?? "legacy"}`;
  const draftText = textTarget === editorKey ? text : "";
  const setDraftText = (value: string) => { setTextTarget(editorKey); setText(value); };

  return (
    // Редизайн 30.08.2026: стеклянная карточка вместо border-blue/bg-card.
    // max-w-2xl вместо всей ширины: поле ответа на два абзаца шириной в монитор
    // читается хуже и выглядит как ошибка вёрстки (замечание владельца).
    <div className="glass-notice glass-notice-enter p-4 mb-4 w-full max-w-2xl">
      <div className="flex items-start gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[13px] bg-blue/10 text-blue">
          <HelpCircle className="w-4 h-4" />
        </span>
        <div className="min-w-0 flex-1">
          <b className="text-[15px] font-semibold block">Бот обещал клиенту уточнить</b>
          <span className="text-[15px] text-gray-400">
            {current.clientName ?? "Клиент из мессенджера"} · спросил {relativeTime(current.askedAt)}
          </span>
        </div>
        {/* Очередь листается, а не просто считается: вопросы разные, и отвечать
            на них удобнее подряд, не дожидаясь, пока уйдёт первый. */}
        {items.length > 1 && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              aria-label="Предыдущий вопрос"
              disabled={index === 0}
              onClick={() => {
                setIndex((i) => i - 1);
                setText("");
              }}
              className="glass-btn glass-btn-ghost tap-target p-1.5 disabled:opacity-40"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <span className="text-[13px] text-gray-500 tabular-nums">
              {index + 1} из {items.length}
            </span>
            <button
              type="button"
              aria-label="Следующий вопрос"
              disabled={index >= items.length - 1}
              onClick={() => {
                setIndex((i) => i + 1);
                setText("");
              }}
              className="glass-btn glass-btn-ghost tap-target p-1.5 disabled:opacity-40"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}
      </div>

      {/* САМ ВОПРОС — крупно и отдельно: это то, на что человек отвечает, и
          теряться среди подписей он не должен. */}
      <p className="mt-2.5 rounded-control bg-blue/5 px-3 py-2 text-[15px] leading-relaxed text-ink">
        {current.question}
      </p>

      {/* О КАКОЙ КВАРТИРЕ РЕЧЬ. Без этого ответить нельзя: «ещё продаётся?» — про
          что? Фото и цена узнаются взглядом, номер открывает карточку объекта. */}
      {current.propertyTitle && (
        <Link
          to={current.propertyShortId ? `/properties/${current.propertyShortId}` : "#"}
          className="mt-2 flex items-center gap-2.5 rounded-2xl border border-line p-2 hover:bg-hover-tint"
        >
          {current.propertyThumbUrl ? (
            <img src={current.propertyThumbUrl} alt="" loading="lazy" decoding="async" className="h-11 w-11 shrink-0 rounded-md object-cover" />
          ) : (
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-line-soft text-gray-400">
              <Home className="h-4 w-4" />
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[15px] font-semibold">
              {current.propertyShortId ? `${formatPropertyCode(current.propertyShortId)} · ` : ""}
              {current.propertyTitle}
            </span>
            {current.propertyPrice && (
              <span className="block text-[15px] text-gray-500">
                {formatMoney(current.propertyPrice, (current.propertyCurrency as Currency) ?? "TJS")}
              </span>
            )}
          </span>
        </Link>
      )}

      {/* ПЕРЕПИСКА В ОДНО НАЖАТИЕ. Раньше до неё надо было дойти самому: найти
          клиента в списке, открыть карточку, развернуть чат. */}
      {current.clientShortId && (
        <Link
          to={`/clients/${current.clientShortId}`}
          state={{ openChat: true }}
          className="mt-2 inline-flex items-center gap-1.5 text-[15px] font-semibold text-blue hover:underline"
        >
          <MessageCircle className="w-3.5 h-3.5" />
          Открыть переписку с клиентом
        </Link>
      )}

      {answeredHeld ? (
        <div className="mt-3 rounded-control bg-blue/5 px-3 py-2 text-[15px]" role="status">
          <p className="font-medium">Ответ сохранён, клиенту ещё не доставлен</p>
          <p className="mt-1 whitespace-pre-wrap break-words">{current.answer}</p>
          <p className="mt-2 text-[14px] text-gray-500">Проверьте исходную переписку перед отправкой вручную. Вопрос остаётся в очереди.</p>
        </div>
      ) : <>
      <div className="mt-2.5 flex flex-wrap gap-1.5">
        {QUICK_ANSWERS.map((q) => (
          <button
            key={q}
            type="button"
            onClick={() => setDraftText(q)}
            className="glass-btn glass-btn-secondary px-3 py-1.5 text-[15px]"
          >
            {q}
          </button>
        ))}
      </div>

      <textarea
        value={draftText}
        onChange={(e) => setDraftText(e.target.value)}
        rows={2}
        aria-label="Ответ на вопрос собственнику"
        placeholder={managed ? "Ответ сохранится в CRM; автоматическая отправка пока недоступна" : "Ответ клиенту: уйдёт ему в переписку как есть"}
        className="mt-2 w-full border border-line rounded-2xl bg-card text-ink px-3.5 py-2.5 text-[15px] outline-hidden focus:border-blue"
      />
      <div className="flex items-center flex-wrap gap-2 mt-2.5">
        <button
          type="button"
          disabled={answer.isPending || draftText.trim().length < 5}
          onClick={() =>
            answer.mutate(
              { id: current.id, answer: draftText, ...(current.managedRevision ? { expectedRevision: current.managedRevision } : {}) },
              {
                onSuccess: (r) => {
                  setText("");
                  // Отвеченный вопрос уходит из очереди — возвращаемся к первому,
                  // иначе указатель показывал бы на соседний по счёту, а не на тот,
                  // что человек видел.
                  setIndex(0);
                  // Честно различаем «ответил» и «клиент получил»: сеть могла
                  // подвести, и человек должен узнать об этом сразу.
                  setNote(r.delivered ? null : r.message);
                },
              }
            )
          }
          className="glass-btn glass-btn-primary text-[15px] px-4 py-2"
        >
          {managed ? "Сохранить ответ" : "Ответить клиенту"}
        </button>
        {note && <span className="text-[15px] text-amber">{note}</span>}
      </div>
      <MutationError mutation={answer} fallback="Не удалось отправить ответ" className="mt-2" />
      </>}
    </div>
  );
}

/**
 * То же самое одной строкой — для всех разделов, кроме «Главной» и «Сообщений».
 *
 * ЗАЧЕМ. Панель ответа висела первой на всех 25 экранах CRM: в «Финансах»,
 * «Архиве», «Телефонии», «Профиле». На компьютере она занимала ~320 px, на
 * телефоне — около двух третей экрана до сгиба, то есть любой раздел открывался
 * ниже видимой области. Отвечать собственнику из «Архива» никто не собирается,
 * а вот знать, что вопрос ждёт, нужно везде.
 *
 * Поэтому здесь только напоминание со счётчиком и переходом туда, где отвечают.
 *
 * ОБЛИК. Строку монтирует AppLayout над содержимым любого раздела, а CSS темы
 * «Royal Home 2026» действует только внутри `.rh2`. Поэтому новый вид включается
 * пропом `rh2` — AppLayout передаёт его ровно на перенесённых экранах; на
 * остальных строка обязана остаться прежней, иначе осталась бы без стилей.
 *
 * ПОЛНАЯ ПАНЕЛЬ (OwnerQuestionsBanner выше) на перенесённые экраны не попадает
 * вовсе: AppLayout рисует её только на «Главной» и в «Сообщениях», а оба этих
 * экрана ещё не переносились, — поэтому у неё пропа нет и старый вид не тронут.
 */
export function OwnerQuestionsStrip({ rh2 = false }: { rh2?: boolean } = {}) {
  const can = useCan();
  const { data } = useOwnerQuestions({ enabled: can("dashboard.analytics") });
  const count = data?.items?.length ?? 0;

  if (!can("dashboard.analytics") || count === 0) return null;

  const line = `Бот обещал клиенту уточнить: ${count} ${
    count === 1 ? "вопрос ждёт ответа" : count < 5 ? "вопроса ждут ответа" : "вопросов ждут ответа"
  }`;

  if (rh2) {
    return (
      <Rh2Inline>
        <div className="card tight" style={{ marginBottom: 16 }}>
          <div className="quiet">
            <HelpCircle className="i" />
            <span className="txt">{line}</span>
            <Link className="lnk" to="/">
              Ответить
            </Link>
          </div>
        </div>
      </Rh2Inline>
    );
  }

  return (
    <Link
      to="/"
      className="glass-notice mb-4 flex items-center gap-2.5 px-4 py-2.5 text-[15px] hover:brightness-[0.98]"
    >
      <HelpCircle className="h-4 w-4 shrink-0 text-blue" />
      <span className="min-w-0 flex-1 truncate font-medium text-gray-700">
        Бот обещал клиенту уточнить: {count}{" "}
        {count === 1 ? "вопрос ждёт ответа" : count < 5 ? "вопроса ждут ответа" : "вопросов ждут ответа"}
      </span>
      <span className="shrink-0 font-bold text-blue">Ответить →</span>
    </Link>
  );
}
