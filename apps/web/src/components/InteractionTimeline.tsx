import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import {
  ArrowRightLeft,
  Bot,
  CalendarCheck,
  ChevronDown,
  ChevronRight,
  Home,
  Headphones,
  MessageCircle,
  Phone,
  Sparkles,
  UserX,
  type LucideIcon,
} from "lucide-react";
import {
  INTERACTION_OUTCOME_LABELS,
  INTERACTION_TYPE_LABELS,
  actorLabel,
  humanNote,
  showingConfirmationBadge,
} from "../lib/clientFormat";
import { dushanbeDate, dushanbeDayKey, dushanbeDayLabel, dushanbeTime } from "../lib/date";
import { CallDetails, TranscriptionStatus, formatCallDuration, scoreTone } from "./CallDetails";
import { VoiceNotePlayer } from "./VoiceNotePlayer";
import { PropertyMiniCard } from "./match/PropertyMiniCard";
import type { Interaction } from "../types";

/**
 * Хронология карточки клиента — «выписка по дням».
 *
 * ПЕРЕДЕЛАНО 20.08.2026 (владелец: «компактнее, удобнее, очень красиво, чтобы
 * глазам быстро понять что / где / когда; на телефоне закрытая, раскрывается
 * нажатием»).
 *
 * Что изменилось и почему именно так:
 *
 * 1. ДНИ ГРУППАМИ, ВРЕМЯ ЧАСАМИ. Раньше в каждой строке стояло «5 дней назад», и
 *    двадцать таких подписей подряд не отвечали ни на «когда», ни на «в каком
 *    порядке»: относительное время читается арифметикой, а не глазом. Теперь день
 *    называется ОДИН раз заголовком группы («Сегодня», «Вчера», «18 августа»), а
 *    в строке стоит час — 14:32, табличными цифрами, ровным столбцом справа. Это
 *    и есть «когда» с одного взгляда.
 *
 * 2. НЕТ КАРТОЧКИ НА КАЖДОЕ СОБЫТИЕ. На телефоне каждая запись была отдельной
 *    карточкой с рамкой, отступом 12px и зазором 9px — тридцать с лишним пикселей
 *    оформления на событие, и всё это ВНУТРИ карточки «Хронология», то есть рамка
 *    в рамке. Осталась волосяная линия между записями и заголовок дня — тот же
 *    приём, что в списке сообщений и в журнале звонков.
 *
 * 3. ЗАГОЛОВОК СИСТЕМНОЙ ЗАПИСИ — САМА ЗАПИСЬ. Системных событий в живой карточке
 *    большинство (предложен объект, отправлена ссылка, передача, напоминание), и
 *    у всех был одинаковый заголовок «Система», а суть пряталась строкой ниже.
 *    Теперь текст события и есть заголовок — такая запись занимает одну строку.
 *
 * 4. ВТОРАЯ СТРОКА — «ИСХОД · СУТЬ». Свёрнутая запись показывает не больше двух
 *    строк: сверху что и когда, снизу точка исхода с подписью и начало заметки.
 *    Всё остальное — заметка целиком, запись разговора, «далее», агент —
 *    открывается нажатием на ЛЮБОЕ место строки.
 *
 * Статусы точкой, а не цветной плашкой: та же система, что «Вернулся» в
 * Clients.tsx (ReturnedBadge) — точка не тянет вес пятна фона и легко держит
 * несколько подряд.
 *
 * ОБЛИК — тема «Royal Home 2026» (09.09.2026). Разметка взята дословно из
 * прототипа `screens/activity.html`: группа `.grp` (значок и соединительная
 * линия слева в `.side`, содержимое в `.body`), заголовок `.hd` с `.who`/`.when`,
 * каждое поле раскрытой записи — строка `.ev-l` с `.kind`/`.txt`/`.tm`, подпись
 * дня — `.grp-lab`, «показать ещё» и «взаимодействий нет» — `.state`. Цвет
 * значка и исхода берётся из токенов темы (`--ok`/`--warn`/`--crit`/`--faint`),
 * а не из утилит Tailwind: внутри `.rh2` действует палитра прототипа.
 *
 * Компонент рендерит ТОЛЬКО карточка клиента (ClientDetail.tsx), поэтому он
 * переведён целиком, без переключателя облика.
 */

interface TypeStyle {
  icon: LucideIcon;
  /** Цвет значка — единственное оформление типа (без подложки), токеном темы. */
  fg: string;
}

const TYPE_STYLES: Record<string, TypeStyle> = {
  CALL: { icon: Phone, fg: "var(--ink)" },
  SHOWING: { icon: Home, fg: "var(--lav-ink)" },
  MEETING: { icon: CalendarCheck, fg: "var(--warn)" },
  MESSAGE: { icon: MessageCircle, fg: "var(--ok)" },
  STATUS_CHANGE: { icon: ArrowRightLeft, fg: "var(--warn)" },
  SYSTEM: { icon: Bot, fg: "var(--faint)" },
};

/** Незнакомый тип не должен ломать хронологию — показываем нейтрально. */
const FALLBACK_STYLE: TypeStyle = { icon: Bot, fg: "var(--faint)" };

/**
 * События типа SYSTEM пишет не человек, а сама CRM, и в реальной карточке их
 * большинство: предложенные объекты, отправленные ссылки, передачи, отказы,
 * напоминания бота. Все они были одинаково серыми с иконкой робота — хронология
 * выглядела мёртвой, и в ней невозможно было выхватить глазами главное.
 * Разбираем по тексту записи: он формируется нами же и стабилен.
 */
const SYSTEM_PATTERNS: { match: RegExp; style: TypeStyle }[] = [
  { match: /ссылк|предложен объект/i, style: { icon: Home, fg: "text-violet" } },
  { match: /показ/i, style: { icon: CalendarCheck, fg: "text-violet" } },
  { match: /отказ/i, style: { icon: UserX, fg: "text-red" } },
  { match: /передан|переназнач|принял лид|назначен/i, style: { icon: ArrowRightLeft, fg: "text-blue" } },
  { match: /напомин|бот/i, style: { icon: Bot, fg: "text-amber" } },
  { match: /заявк|лид/i, style: { icon: Sparkles, fg: "text-green" } },
];

function styleFor(type: string, notes: string | null | undefined): TypeStyle {
  if (type === "SYSTEM" && notes) {
    const hit = SYSTEM_PATTERNS.find((p) => p.match.test(notes));
    if (hit) return hit.style;
  }
  return TYPE_STYLES[type] ?? FALLBACK_STYLE;
}

/** Исход важнее типа: отказ и недозвон обязаны быть видны без чтения заметки —
 *  плашкой прототипа `.chip` с точкой `.dot` внутри (screens/clients.html). */
const OUTCOME_DOT: Record<string, string> = {
  POSITIVE: "ok",
  NEUTRAL: "mute",
  NEGATIVE: "crit",
  NO_ANSWER: "warn",
};

/** Оттенок плашки для confirmation-бейджа показа — берём по тексту, а не трогаем
 *  className из showingConfirmationBadge (lib/clientFormat.ts): её также
 *  использует Calendar.tsx/MobileCalendar.tsx плашками, менять форму нельзя. */
function confirmationDotColor(label: string): string {
  if (label === "Подтвердил") return "ok";
  if (label === "Ждём подтверждения") return "warn";
  return "crit"; // «Отменён» / «Не сможет прийти»
}

/** Плашка прототипа с точкой. Цвет никогда не единственный носитель смысла —
 *  подпись рядом обязательна (иначе запись нечитаема при дальтонизме и в ч/б). */
function StatusDot({ color, children }: { color: string; children: string }) {
  return (
    <span className={`chip ${color}`}>
      {color !== "mute" && <span className={`dot ${color}`} />}
      {children}
    </span>
  );
}

/**
 * ЗАПИСЬ РАЗГОВОРА ПРЯМО В ХРОНОЛОГИИ (владелец 15.08.2026: «пусть в хронологии тоже
 * это будет»).
 *
 * Раньше звонок в карточке был строкой текста: агент видел «разговор 2:03» и пересказ
 * от ИИ, а послушать себя или перечитать, что именно обещал клиенту, мог только
 * директор в разделе «Звонки». Теперь свой разговор раскрывается на месте — там же,
 * где человек читает историю клиента, а не в другом разделе.
 *
 * Что показывать, решает сервер: `canRead`/`canHear` приходят из
 * lib/callTranscripts.ts. Чужой разговор остаётся строкой с пометкой «запись есть»
 * — как и было. С 04.09.2026 они разведены: `canRead` — можно ли читать
 * расшифровку/разбор (было единственным `canHear` до этой даты), `canHear` —
 * можно ли ДОПОЛНИТЕЛЬНО прослушать звук (руководство/СБ/маркетинг). Свой
 * разговор агент по-прежнему читает целиком, просто без плеера.
 */
function CallEntry({ interaction }: { interaction: Interaction }) {
  const [open, setOpen] = useState(false);
  const analysis = interaction.callAnalysis ?? null;
  const detailsId = `timeline-call-${interaction.id}`;
  const stage = interaction.transcriptionStage ?? null;

  /**
   * ТЕКСТ РАЗГОВОРА — ЛЕНИВО (26.08.2026). Карточка клиента больше не тянет
   * расшифровки всех 200 записей хронологии (мегабайты на открытие) — сервер
   * присылает только признак hasTranscript, а сам текст запрашивается здесь,
   * ровно когда человек развернул запись. В разделах «Звонки»/«Телефония»
   * transcript по-прежнему приходит сразу — там условие не срабатывает.
   */
  const needLazyTranscript = open && !!interaction.canRead && !!interaction.hasTranscript && !interaction.transcript;
  const { data: lazyTranscript } = useQuery({
    queryKey: ["interaction-transcript", interaction.id],
    queryFn: () =>
      api<{ transcript: string | null; transcriptRu: string | null }>(`/interactions/${interaction.id}/transcript`),
    enabled: needLazyTranscript,
    staleTime: Infinity,
  });

  /**
   * Живой статус виден ВСЕМ, вне зависимости от canRead/canHear: это факт о том,
   * что сейчас происходит с записью (ищем/расшифровываем/переводим), а не
   * содержимое разговора. Показывается и до того, как hasRecording станет true —
   * станция может искаться до получаса секунд (см. lib/telephony/
   * callRecordings.ts, SEARCHING), и молчание в этот момент от «разговора без
   * записи» не отличить.
   */
  const status = stage && <TranscriptionStatus stage={stage} progress={interaction.transcriptionProgress} />;

  // ЧТЕНИЕ, не звук: чужой разговор закрыт целиком, как и раньше (04.09.2026 не
  // трогает эту границу — сужен только доступ к плееру, см. canHear ниже).
  if (!interaction.canRead) {
    if (status) return <div className="ev-l">{status}</div>;
    // Факт записи виден всем — иначе разговор выглядел бы пропавшим бесследно.
    if (!interaction.hasRecording && !interaction.hasTranscript) return null;
    return (
      <div className="ev-l">
        <span className="kind">Запись</span>
        <span className="txt">Разговор записан · слушать и читать может тот, кто его вёл, и администрация</span>
      </div>
    );
  }

  // Открывать нечего: запись ещё не нашлась, и конвейер ею тоже не занят (событие
  // отбоя могло не успеть дойти). Секундная пустота лучше кнопки в никуда.
  if (!interaction.hasRecording && !interaction.transcript && !analysis && !status) return null;

  return (
    <div>
      {status && <div className="ev-l">{status}</div>}
      {interaction.hasRecording && (
        <button
          className="pill ghost sm"
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={detailsId}
        >
          {open ? <ChevronDown className="i" /> : <ChevronRight className="i" />}
          <Headphones className="i" />
          {/* Подпись честно называет то, что доступно: агенту, читающему свой
              разговор без права на звук (04.09.2026), «Послушать» было бы враньём. */}
          <span>
            {open ? "Свернуть разговор" : interaction.canHear ? "Послушать и прочитать разговор" : "Прочитать разговор"}
          </span>
          {interaction.recordingDurationSec ? (
            <span className="meta">{formatCallDuration(interaction.recordingDurationSec)}</span>
          ) : null}
          {analysis && (
            // Балл разговора плашкой прототипа. Отдельной обёртки `.rh2` здесь
            // больше не нужно: карточка клиента перенесена и сама её даёт
            // (ClientDetail.tsx) — вложенная заново объявила бы переменные темы.
            <span className={`chip ${scoreTone(analysis.score)} ml-auto`}>{analysis.score}</span>
          )}
        </button>
      )}

      {open && interaction.hasRecording && (
        <div id={detailsId} className="card flat" style={{ marginTop: 8, padding: "10px 12px" }}>
          <CallDetails
            interactionId={interaction.id}
            createdAt={interaction.createdAt}
            hasRecording={!!interaction.hasRecording}
            canHear={!!interaction.canHear}
            transcript={interaction.transcript ?? lazyTranscript?.transcript ?? null}
            transcriptRu={interaction.transcriptRu ?? lazyTranscript?.transcriptRu ?? null}
            analysis={analysis}
            // outcome/notes НЕ передаём: строка хронологии уже показывает оба в
            // заголовке до раскрытия (statuses/gist выше) — повтор внутри
            // раскрытого блока дублировал бы текст на экране.
            recordingDurationSec={interaction.recordingDurationSec}
            agentName={interaction.agent?.fullName ?? interaction.subjectAgent?.fullName ?? null}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Одна запись. Свёрнута всегда — не больше двух строк; раскрывается нажатием в
 * ЛЮБОЕ место строки (владелец 20.08.2026: «сейчас только в определённых местах
 * надо нажать»).
 *
 * role/tabIndex/onKeyDown — потому что это div, а не кнопка: без них строка
 * перестала бы открываться с клавиатуры и пропала бы для чтения с экрана.
 * Кнопкой сделать нельзя — внутри раскрытой записи живут свои кнопки (плеер,
 * «послушать разговор»), а кнопка в кнопке невалидна.
 */
function TimelineRow({ i, firstOfDay }: { i: Interaction; firstOfDay: boolean }) {
  const style = styleFor(i.type, i.notes);
  const Icon = style.icon;
  // Подтверждение показа клиентом: руководитель и агент должны видеть его там
  // же, где читают историю, — иначе о срыве узнают уже на месте.
  const confirmation = showingConfirmationBadge(i);
  const [open, setOpen] = useState(false);

  // Системная запись — это и есть свой заголовок (см. п.3 в шапке файла): «Система»
  // ничего не сообщала, а суть уезжала во вторую строку.
  const isSystem = i.type === "SYSTEM";
  // humanNote — чтобы служебный код источника (`[lifecycle.assign]` и подобные)
  // не доезжал до экрана; в базе он остаётся, см. lib/clientFormat.ts.
  const title = isSystem && i.notes ? humanNote(i.notes) : (INTERACTION_TYPE_LABELS[i.type] ?? i.type);
  const gist = isSystem ? null : i.notes;
  /**
   * КТО ДЕЙСТВОВАЛ — В ЗАГОЛОВКЕ, БЕЗ РАСКРЫТИЯ (П-10, 17.09.2026, владелец:
   * «каждый раз приходится раскрывать»). Только для не-агента: у AGENT имя и
   * так одним кликом («Кто» ниже) — тип записи в заголовке уже был решением
   * 20.08.2026 и его трогать незачем. Для SYSTEM/AI/BOT/CLIENT агента в поле
   * `agent` больше нет вовсе (agentId=null), и без этой подписи автор строки
   * стал бы не видно кем — то самое, из чего Р-8 родился.
   */
  const actor = actorLabel(i);

  const statuses: { color: string; label: string }[] = [];
  if (i.outcome) {
    statuses.push({
      color: OUTCOME_DOT[i.outcome] ?? "bg-gray-400",
      label: INTERACTION_OUTCOME_LABELS[i.outcome] ?? i.outcome,
    });
  }
  if (confirmation) statuses.push({ color: confirmationDotColor(confirmation.label), label: confirmation.label });

  const hasBody = !!i.notes || !!i.nextAction || !!i.agent?.fullName || i.type === "CALL";
  /**
   * Есть ли что показать ПОД заголовком в раскрытом виде. У системной записи
   * раскрытие часто добавляет только одно: заголовок перестаёт обрезаться
   * многоточием (её текст и есть заголовок) — и тогда пустой блок ниже даёт
   * лишний зазор без содержимого.
   */
  const hasDetails =
    statuses.length > 0 || (!isSystem && !!i.notes) || i.type === "CALL" || !!i.nextAction || !!i.agent?.fullName;
  const toggle = () => hasBody && setOpen((v) => !v);

  return (
    <div
      onClick={toggle}
      onKeyDown={(e) => {
        if (!hasBody) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
      role={hasBody ? "button" : undefined}
      tabIndex={hasBody ? 0 : undefined}
      aria-expanded={hasBody ? open : undefined}
      className="grp"
      style={{ cursor: hasBody ? "pointer" : undefined, borderTop: firstOfDay ? "0" : undefined }}
    >
      {/* Значок и соединительная линия — `.side` прототипа (activity.html).
          Подложки у значка нет, цвет — токен темы. */}
      <div className="side">
        <span className="av" style={{ color: style.fg }}>
          <Icon className="i" />
        </span>
        <span className="ln" />
      </div>

      <div className="body">
        {/* Заголовок группы: что слева, час справа (`.hd` → `.who`/`.when`). */}
        <div className="hd">
          {/* Свёрнутая — ровно одна строка с многоточием; раскрытая — переносится
              целиком. У системной записи заголовок И ЕСТЬ её текст, и без этого
              длинное событие («заявку не принял никто из 4 агентов…») нельзя было
              бы дочитать вовсе: в раскрытом теле оно намеренно не дублируется. */}
          <span
            className="who"
            style={
              open
                ? { minWidth: 0, flex: 1, overflowWrap: "anywhere" }
                : {
                    minWidth: 0,
                    flex: 1,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }
            }
          >
            {actor && (
              <span style={{ color: "var(--faint)", fontWeight: 500 }}>
                {actor}
                {" · "}
              </span>
            )}
            {title}
          </span>
          <span className="when">{dushanbeTime(i.createdAt)}</span>
          {hasBody && (open ? <ChevronDown className="i" /> : <ChevronRight className="i" />)}
        </div>

        {/* Мини-карточка объекта (задание D, 17.09.2026, `docs/match-policy-plan-17-09.md`
            §6, «Хронология клиента»): владелец просил карточки «везде и
            кликабельные, чтобы три часа не искать рекомендуемый объект».
            Рисуется, ТОЛЬКО когда сервер прислал фото у записи — иначе запись
            остаётся прежним текстом (i.property без photos — старый сервер или
            старая запись, второго источника правды не заводим). */}
        {i.property && i.property.photos && i.property.photos.length > 0 && (
          <PropertyMiniCard property={i.property} />
        )}

        {/* Строка «исход · суть» — только в свёрнутом виде: раскрытая запись
            показывает и то, и другое полностью, и дубль был бы шумом. */}
        {!open && (statuses.length > 0 || gist) && (
          <div className="ev-l">
            {statuses.map((s) => (
              <StatusDot key={s.label} color={s.color}>
                {s.label}
              </StatusDot>
            ))}
            {/* minWidth: 0 обязателен: у элемента flex ширина по умолчанию не падает
                ниже содержимого, и длинная заметка не сжималась бы, а обрезалась
                краем контейнера — без многоточия, то есть без признака, что текст
                продолжается. */}
            {gist && (
              <span
                className="txt"
                style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
              >
                {gist}
              </span>
            )}
          </div>
        )}

        {open && hasDetails && (
          /**
           * Раскрытое содержимое НЕ схлопывает строку по клику внутри себя
           * (stopPropagation): там живут кнопки «послушать разговор», ссылки и
           * плеер — нажатие на них должно делать своё дело, а не закрывать
           * запись под пальцем.
           */
          <div onClick={(e) => e.stopPropagation()}>
            {statuses.length > 0 && (
              <div className="ev-l">
                <span className="kind">Исход</span>
                <span className="txt wrap">
                  {statuses.map((s) => (
                    <StatusDot key={s.label} color={s.color}>
                      {s.label}
                    </StatusDot>
                  ))}
                </span>
              </div>
            )}

            {/* Системную запись во второй раз не печатаем: она уже стоит
                заголовком строки — там её видно целиком, перенос разрешён. */}
            {!isSystem && i.notes && (
              <div className="ev-l">
                <span className="kind">Заметка</span>
                <span className="txt" style={{ overflowWrap: "anywhere" }}>
                  {i.notes}
                </span>
              </div>
            )}

            {/* Голосовая заметка агента (01.09.2026, кнопка микрофона в форме итога) —
                файл как есть, не расшифровка вместо notes. */}
            {i.voiceNoteUrl && (
              <div className="ev-l">
                <span className="kind">Голосом</span>
                <span className="txt">
                  <VoiceNotePlayer url={i.voiceNoteUrl} rh2 />
                  {i.voiceNoteTranscript && (
                    <span className="note" style={{ display: "block", color: "var(--faint)" }}>
                      Распознано: «{i.voiceNoteTranscript}»
                    </span>
                  )}
                </span>
              </div>
            )}

            {/* Звонок раскрывается на месте: запись, расшифровка, разбор и совет. */}
            {i.type === "CALL" && <CallEntry interaction={i} />}

            {i.nextAction && (
              <div className="ev-l">
                <span className="kind">Далее</span>
                <span className="txt">
                  {i.nextAction}
                  {/* Через dushanbeDate, как и вся остальная хронология: это было
                      единственное место здесь без часового пояса, и около полуночи
                      оно называло соседний день — в тексте, который сервер собрал
                      по Душанбе. */}
                  {i.nextActionDate ? ` · ${dushanbeDate(i.nextActionDate)}` : ""}
                </span>
              </div>
            )}

            {i.agent?.fullName && (
              <div className="ev-l">
                <span className="kind">Кто</span>
                <span className="txt">{i.agent.fullName}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Подпись дня — «Сегодня» / «Вчера» / «18 августа». Единственное место, где в
 *  хронологии называется дата: в строках стоит только час. Класс `.grp-lab`
 *  прототипа (activity.html) сам гасит верхний отступ у первой подписи. */
function DayHeading({ label }: { label: string }) {
  return <div className="grp-lab">{label}</div>;
}

/** Плоский список строк: подпись дня и события вперемешку. */
type Row =
  | { kind: "day"; id: string; label: string; first: boolean }
  | { kind: "event"; id: string; i: Interaction; firstOfDay: boolean };

function buildRows(interactions: Interaction[]): Row[] {
  const rows: Row[] = [];
  let currentDay = "";
  for (const i of interactions) {
    const day = dushanbeDayKey(i.createdAt);
    const isNewDay = day !== currentDay;
    if (isNewDay) {
      currentDay = day;
      rows.push({ kind: "day", id: `day-${day}`, label: dushanbeDayLabel(i.createdAt), first: rows.length === 0 });
    }
    rows.push({ kind: "event", id: i.id, i, firstOfDay: isNewDay });
  }
  return rows;
}

/**
 * Сколько записей рисуется сразу. Остальные — по кнопке.
 *
 * ПОЧЕМУ НЕ ВИРТУАЛИЗАЦИЯ (была здесь до 20.08.2026 и снята намеренно).
 * Виртуализатор помнит высоту каждой строки и раскладывает список по этой
 * памяти. Строка хронологии раскрывается по нажатию и становится втрое выше —
 * запись с разбором разговора наезжала на следующие, и вместо истории получалась
 * каша из наложенного текста. Ручной пересчёт замера после раскрытия
 * (`measureElement`) в этой связке версий (react-virtual 3.14 поверх
 * virtual-core 3.17) до раскладки не доходит — проверено на живой карточке.
 *
 * Предел вместо виртуализации даёт то же, ради чего она бралась (в DOM не сотни
 * записей, а два-три десятка), стоит одну строку кода и не может разъехаться:
 * обычный поток, высота какая есть. Открывают карточку ради свежего, а не ради
 * позапрошлого года, — поэтому дальше по кнопке, а не бесконечной прокруткой.
 */
const INITIAL_EVENTS = 25;
/** Сколько добавляет одно нажатие «Показать ещё». */
const MORE_EVENTS = 50;

/** Сколько старых записей приносит одно нажатие «Показать более ранние». */
const OLDER_BATCH = 50;
const NO_ROWS: Interaction[] = [];

interface OlderPage {
  items: Interaction[];
  total: number;
  hasMore: boolean;
}

/** Строки без повторов, первая копия побеждает (свежая карточка — раньше догруженной). */
function mergeById(...lists: Interaction[][]): Interaction[] {
  const seen = new Set<string>();
  const out: Interaction[] = [];
  for (const list of lists) {
    for (const i of list) {
      if (seen.has(i.id)) continue;
      seen.add(i.id);
      out.push(i);
    }
  }
  return out;
}

/**
 * «ПОКАЗАНЫ 25 ИЗ 200» БОЛЬШЕ НЕ ВРЁТ (02.10.2026, класс «Пагинация»). Карточка
 * приносит последние 200 записей; раньше экран считал их всей историей, и у
 * клиента, которого ведут год, всё старше двухсот было не увидеть. Теперь
 * `total` — настоящее число с сервера (interactionsTotal), а когда пришедшие с
 * карточкой записи кончились, кнопка «Показать более ранние» догружает
 * следующие курсором (GET /clients/:id/timeline) — открытие карточки от этого
 * не тяжелеет. `truncated` — карточка отдала не всё (для среза «Звонки» число
 * заранее не известно, сервер назовёт его с первой догрузкой).
 */
export function InteractionTimeline({
  interactions,
  clientId,
  total,
  truncated = false,
  type,
}: {
  interactions: Interaction[];
  clientId?: string;
  total?: number;
  truncated?: boolean;
  type?: Interaction["type"];
}) {
  const [limit, setLimit] = useState(INITIAL_EVENTS);
  // Догруженное держим вместе с ключом клиента/среза: другой клиент или срез —
  // начинаем с чистого листа, без чужих строк.
  const ownerKey = `${clientId ?? ""}|${type ?? ""}`;
  const [older, setOlder] = useState<{
    key: string;
    pinned: Interaction[];
    items: Interaction[];
    total: number | null;
    hasMore: boolean | null;
  }>({ key: ownerKey, pinned: NO_ROWS, items: NO_ROWS, total: null, hasMore: null });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const state =
    older.key === ownerKey ? older : { key: ownerKey, pinned: NO_ROWS, items: NO_ROWS, total: null, hasMore: null };

  // pinned — то, что пришло с карточкой к моменту первой догрузки: пока
  // карточка открыта, сверху появляются новые записи, и самая старая из двухсот
  // выпала бы из списка, оставив дыру между верхом и догруженным.
  const all = useMemo(
    () => mergeById(interactions, state.pinned, state.items),
    [interactions, state.pinned, state.items]
  );
  const shown = useMemo(() => all.slice(0, limit), [all, limit]);
  const rows = useMemo(() => buildRows(shown), [shown]);
  const rest = all.length - shown.length;
  const hasOlder = !!clientId && (state.hasMore ?? truncated);
  const knownTotal = state.total ?? total ?? (truncated ? null : all.length);

  async function loadOlder() {
    const last = all[all.length - 1];
    if (!clientId || !last || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const params = new URLSearchParams({
        before: last.createdAt,
        beforeId: last.id,
        limit: String(OLDER_BATCH),
      });
      if (type) params.set("type", type);
      const page = await api<OlderPage>(`/clients/${clientId}/timeline?${params.toString()}`);
      setOlder({
        key: ownerKey,
        pinned: state.pinned.length > 0 ? state.pinned : interactions,
        items: [...state.items, ...page.items],
        total: page.total,
        hasMore: page.hasMore,
      });
      setLimit((v) => v + OLDER_BATCH);
    } catch {
      setOlderError(true);
    } finally {
      setLoadingOlder(false);
    }
  }

  if (all.length === 0) {
    return <div className="state">Взаимодействий пока нет</div>;
  }

  return (
    <div>
      {rows.map((row) =>
        row.kind === "day" ? (
          <DayHeading key={row.id} label={row.label} />
        ) : (
          <TimelineRow key={row.id} i={row.i} firstOfDay={row.firstOfDay} />
        )
      )}
      {/* «Показано N из M» строкой `.state` с ссылкой `.lk` — дословно как в
          прототипе (activity.html, client-detail.html). */}
      {(rest > 0 || hasOlder) && (
        <p className="state">
          Показаны {shown.length}
          {knownTotal !== null ? ` из ${knownTotal}` : ""}.{" "}
          {rest > 0 ? (
            <button className="lk" type="button" onClick={() => setLimit((v) => v + MORE_EVENTS)}>
              Показать ещё ({Math.min(rest, MORE_EVENTS)})
            </button>
          ) : (
            <button className="lk" type="button" disabled={loadingOlder} onClick={() => void loadOlder()}>
              {loadingOlder ? "Загружаем…" : "Показать более ранние"}
            </button>
          )}
          {olderError && " Не удалось загрузить, попробуйте ещё раз."}
        </p>
      )}
    </div>
  );
}
