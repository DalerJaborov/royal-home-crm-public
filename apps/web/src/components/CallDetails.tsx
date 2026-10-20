import { useEffect, useState } from "react";
import {
  CALL_TRANSCRIPTION_STAGE_LABELS,
  MIN_ANALYZED_TRANSCRIPT_CHARS,
  type CallTranscriptionStage,
  type InteractionOutcome,
} from "@royal-home/shared";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "../lib/api";
import { dushanbeDayKey } from "../lib/date";
import { INTERACTION_OUTCOME_LABELS } from "../lib/clientFormat";
import type { CallAnalysis } from "../types";
import { IconCheck } from "./proto/ProtoIcons";
import { Rh2Inline } from "./rh2/Rh2Scope";
import { TranscriptView } from "./TranscriptView";
import { translationResetFor } from "../lib/callTranslationSync";

/**
 * Разговор целиком: запись, разбор и расшифровка.
 *
 * ОДИН КОМПОНЕНТ НА ТРИ МЕСТА. Раньше всё это жило внутри страницы «Звонки» и было
 * доступно только администрации. С 15.08.2026 свой разговор смотрит и сам агент —
 * в разделе «Звонки» и прямо в хронологии карточки клиента (владелец: «пусть в
 * хронологии тоже это будет»). Два экземпляра одной разметки разошлись бы в первую
 * же правку: где-то остался бы старый порядок блоков, где-то — плеер без скачивания.
 *
 * Правило доступа сюда НЕ зашито: показывать этот блок или нет, решает сервер
 * признаками `canRead`/`canHear` (lib/callTranscripts.ts). Компонент рисует то,
 * что пришло.
 *
 * ЧТЕНИЕ И СЛУШАНИЕ РАЗВЕДЕНЫ (04.09.2026). `canHear` отвечает ТОЛЬКО за плеер —
 * агент читает расшифровку и совет по своему разговору независимо от него, но
 * прослушать запись не может; звук остаётся только у DIRECTOR/ADMIN/SECURITY/
 * MARKETING (право calls.hearRecording).
 *
 * ОБЛИК — ЭТАЛОН «ROYAL HOME 2026» (перенос 09.09.2026): блок «Разбор разговора»
 * из `docs/pult/theme-2026/screens/calls.html` — лента шагов `.rail`, подзаголовки
 * `.sec-t`, мини-плеер `.player`. Корень обёрнут в `.rh2` СВОИМ классом, а не
 * унаследован от страницы: этот же блок раскрывается в хронологии карточки
 * клиента (`InteractionTimeline`), которая на эталон ещё не переведена, и без
 * собственной обёртки он остался бы там без стилей вовсе.
 */

/** Счёт — не «оценка сотрудника», а насколько разговор продвинул сделку.
 *  Возвращает модификатор прототипного `.score`/`.chip`, а не Tailwind-классы. */
/**
 * КЛЮЧИ, КОТОРЫЕ ОБНОВЛЯЕТ «РАСШИФРОВАТЬ ЗАНОВО» (правка ревью 24.09.2026).
 *
 * До этой правки requestRetranscribe вызывал `queryClient.invalidateQueries()`
 * БЕЗ фильтра — это не «обновить звонок», а сброс ВСЕГО кэша react-query разом:
 * каждая открытая страница (клиенты, объекты, доска, настройки — что угодно,
 * что смонтировано в эту секунду) перезапрашивает себя заново ради обновления
 * одной расшифровки одного звонка.
 *
 * Список собран по местам, где реально показывается этот компонент и то, что он
 * меняет (запись/расшифровка/разбор звонка): список и карточки звонков (Calls.tsx
 * → hooks/useCalls.ts), ленивая расшифровка в хронологии (InteractionTimeline.tsx),
 * карточка клиента (ClientDetail.tsx → useClient — интеракции лежат ВНУТРИ объекта
 * client, отдельного ключа под них нет).
 */
const RETRANSCRIBE_INVALIDATE_KEYS = new Set<string>([
  "client",
  "calls",
  "incoming-calls",
  "call-feed",
  "calls-summary",
  "call-insights",
  "telephony-dashboard",
  "interaction-transcript",
]);

export function scoreTone(score: number): string {
  if (score >= 70) return "ok";
  if (score >= 45) return "warn";
  return "crit";
}

export function formatCallDuration(seconds: number | null | undefined): string {
  if (!seconds) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * ЖИВОЙ СТАТУС КОНВЕЙЕРА (владелец 15.08.2026): «человек не должен просто сидеть и
 * ждать секунды, пока это всё расшифровывается» — эта строка и есть ответ. Вместо
 * статичного «Разбор ещё готовится», которое от отбоя до готового разбора не
 * менялось ни разу (и однажды владелец решил по нему, что расшифровка сломалась),
 * здесь видно, на каком именно шаге разговор — с процентом на самом долгом из них.
 *
 * Облик — строка состояния `.state` со скелетонами `.sk`: движение слева от текста
 * само по себе сигнал «идёт работа», его считывают быстрее, чем читают слово.
 */
export function TranscriptionStatus({
  stage,
  progress,
}: {
  stage: CallTranscriptionStage;
  progress?: number | null;
}) {
  const showPercent = stage === "TRANSCRIBING" && typeof progress === "number" && progress > 0;
  return (
    // Своя обёртка `.rh2`: строка раскрывается и в хронологии карточки клиента,
    // которая на эталон ещё не переведена (см. разбор в шапке файла).
    <Rh2Inline>
      <div className="state">
        <span className="sk w22" />
        {CALL_TRANSCRIPTION_STAGE_LABELS[stage]}
        {showPercent ? ` · ${progress}%` : "…"}
      </div>
    </Rh2Inline>
  );
}

/** Шаг разговора в ленте `.rail`: пройденный получает галочку, остальные — номер. */
function Step({ done, index, label }: { done: boolean; index: number; label: string }) {
  return (
    <span className={`st${done ? " done" : ""}`}>
      <span className="b">{done ? <IconCheck /> : index}</span>
      <span>{label}</span>
    </span>
  );
}

/**
 * Один и тот же вид у возражений/договорённостей/совета/тадж. пересказа — раньше
 * каждое поле было оформлено по-своему (совет — в цветной рамке, остальные —
 * голым текстом с надписью через двоеточие), и глаз не понимал, где заканчивается
 * одно поле и начинается другое (владелец 19.08.2026: «бардак»). В эталоне тот же
 * ритм даёт подзаголовок `.sec-t` и текст под ним.
 */
function AnalysisField({ label, children }: { label: string; children: string }) {
  return (
    <>
      <div className="sec-t">{label}</div>
      <p style={{ fontSize: "var(--fs-15)", color: "var(--body)", textWrap: "pretty" }}>{children}</p>
    </>
  );
}

/**
 * Плеер записи — через fetch с токеном, а НЕ через src на маршрут CRM.
 *
 * Так было раньше, и не работало вовсе: `<audio src="/api/v1/interactions/…">` и
 * ссылка «Скачать» — обычные запросы браузера, а CRM авторизует по заголовку
 * Authorization, которого в них нет. Сервер отвечал 401, плеер показывал 0:00 / 0:00,
 * скачивание молча ничего не давало (жалоба владельца 10.08.2026). Куки-сессии, на
 * которую можно было бы опереться, у access-токена нет: в куке живёт только refresh.
 *
 * Поэтому файл забирается тем же слоем api(), что и всё остальное, и отдаётся плееру
 * ссылкой на объект в памяти. Она же идёт в «Скачать» — качается уже полученный файл,
 * второй раз со станции он не тянется.
 *
 * ВНУТРИ `.player` СТОИТ РОДНОЙ `<audio controls>`, а не полоска `.bar` из макета:
 * в прототипе полоса нарисованная, а живой плеер умеет пуск, паузу, перемотку
 * (файл уже в памяти вкладки) и громкость. Рамку и подпись даёт эталон, звук — браузер.
 */
/** Расширение файла записи по MIME-типу; неизвестное — mp3, как у станции. */
export function recordingExtension(mime: string): string {
  const t = mime.toLowerCase();
  if (t.includes("wav")) return "wav";
  if (t.includes("ogg")) return "ogg";
  if (t.includes("webm")) return "webm";
  if (t.includes("mp4") || t.includes("m4a") || t.includes("aac")) return "m4a";
  return "mp3";
}

export function CallRecording({ interactionId, createdAt }: { interactionId: string; createdAt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Расширение — по типу ответа: запись робота — WAV, станции — MP3; имя «.mp3» на
  // WAV-файле не открывалось в плеерах.
  const [ext, setExt] = useState("mp3");

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setError(null);
    api<Blob>(`/interactions/${interactionId}/recording`, { responseType: "blob" })
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setExt(recordingExtension(blob.type));
        setUrl(objectUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Не удалось получить запись");
      });
    // Ссылку на объект обязательно отзываем: без этого каждый раскрытый звонок
    // оставлял бы файл в памяти вкладки до перезагрузки страницы.
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [interactionId]);

  if (error)
    return (
      <div className="state err">
        <span className="dot crit" />
        {error}
      </div>
    );
  if (!url)
    return (
      <div className="state">
        <span className="sk w22" />
        Загружаем запись
      </div>
    );

  return (
    // min-w-0 на обёртке и width:100% на самом плеере — не украшение: у
    // <audio controls> своя минимальная ширина от браузера (около 300px), и без
    // этого плеер распирал карточку на телефоне, а страница уезжала вбок.
    <div className="player">
      <div className="tl">
        <audio controls preload="metadata" src={url} style={{ width: "100%", minWidth: 0, height: 36 }} />
        <div className="ts">
          {/* Дата в имени файла — душанбинская: slice(0, 10) резал ISO-строку в UTC,
              и разговор в 02:00 по Душанбе скачивался со вчерашним числом. */}
          <a
            className="lnk"
            href={url}
            download={`Разговор-${dushanbeDayKey(createdAt)}-${interactionId.slice(0, 8)}.${ext}`}
          >
            Скачать запись
          </a>
        </div>
      </div>
    </div>
  );
}

export interface CallDetailsProps {
  interactionId: string;
  createdAt: string;
  hasRecording: boolean;
  /**
   * Можно ли ИМЕННО ЭТОМУ смотрящему прослушать запись (04.09.2026, отдельное
   * право calls.hearRecording — см. lib/callTranscripts.ts). НЕ путать с
   * `hasRecording`: запись может существовать, но быть недоступной для звука —
   * агент по-прежнему читает расшифровку и совет ниже, `canHear` только прячет
   * плеер. По умолчанию true — вызывающие места из ДО 04.09.2026 (если такие
   * остались) не должны молча потерять плеер, который сервер и так отдаёт им
   * закрытым (recordingUrl уже null, если нельзя).
   */
  canHear?: boolean;
  /** Оригинал расшифровки: таджикская речь — таджикской кириллицей. */
  transcript: string | null;
  /** Русский перевод. null — разговор и так шёл по-русски. */
  transcriptRu: string | null;
  analysis: CallAnalysis | null;
  /**
   * Показывать ли объяснение «почему разбора нет». В разделе «Звонки» оно уже стоит
   * в строке списка, в хронологии карточки — нет.
   */
  explainMissingAnalysis?: boolean;
  /**
   * Исход/разбор (notes) звонка — необязательные (24.09.2026): в хронологии
   * карточки клиента (InteractionTimeline) оба уже показаны В ЗАГОЛОВКЕ строки
   * до раскрытия, повторять их здесь — дублировать текст на экране. Передавать
   * стоит только там, где снаружи этого нет (журнал «Звонки»: notes нигде
   * больше не выводится).
   */
  outcome?: InteractionOutcome | null;
  notes?: string | null;
  /** Длительность записи — рядом с заголовком расшифровки. */
  recordingDurationSec?: number | null;
  /** Кем подписывать реплики агента в чате расшифровки вместо родового «Агент». */
  agentName?: string | null;
}

/**
 * РАСКРЫТЫЙ ЗВОНОК — ПЛОТНО И ПО ПОРЯДКУ.
 *
 * Порядок блоков — эталонный: запись, лента пяти шагов, возражения,
 * договорённости, совет агенту, пересказ по-таджикски, расшифровка целиком.
 */
export function CallDetails({
  interactionId,
  createdAt,
  hasRecording,
  canHear = true,
  transcript,
  transcriptRu,
  analysis,
  explainMissingAnalysis = false,
  outcome,
  notes,
  recordingDurationSec,
  agentName,
}: CallDetailsProps) {
  // Перевод не готов заранее, а считается по клику (см. translatedRu ниже) —
  // ИИ-разбору он не нужен вовсе, тот и так читает оригинал. Само переключение
  // оригинал/перевод/рядом теперь рисует TranscriptView — здесь только запрос.
  const [translatedRu, setTranslatedRu] = useState<string | null>(transcriptRu);
  const [translating, setTranslating] = useState(false);
  const [translateError, setTranslateError] = useState<string | null>(null);
  // Разговор и так по-русски — сервер вернул null не из-за ошибки, а по правилу
  // looksTajik. Повторно жать «Показать перевод» после этого незачем.
  const [notNeeded, setNotNeeded] = useState(false);
  // Повторная расшифровка очищает оригинал и перевод на сервере, а строка остаётся
  // раскрытой: сверяем пропсы прямо во время рендера и сбрасываем локальное
  // производное состояние, иначе новый оригинал встанет рядом со старым переводом
  // (WEB-PAGES09).
  const [seenSource, setSeenSource] = useState({ transcript, transcriptRu });
  const translationReset = translationResetFor(seenSource, { transcript, transcriptRu });
  if (translationReset) {
    setSeenSource({ transcript, transcriptRu });
    setTranslatedRu(translationReset.translatedRu);
    setNotNeeded(translationReset.notNeeded);
    setTranslateError(null);
  }

  async function requestTranslation() {
    setTranslating(true);
    setTranslateError(null);
    try {
      const result = await api<{ transcriptRu: string | null }>(`/interactions/${interactionId}/translate`, {
        method: "POST",
      });
      if (result.transcriptRu) {
        setTranslatedRu(result.transcriptRu);
      } else {
        setNotNeeded(true);
      }
    } catch (err) {
      setTranslateError(err instanceof Error ? err.message : "Не удалось перевести");
    } finally {
      setTranslating(false);
    }
  }

  // РАСШИФРОВАТЬ ЗАНОВО (24.09.2026): POST /interactions/:id/retranscribe —
  // контракт сервера (та же ветка): 202 {queued:true} ставит разговор в
  // очередь конвейера повторно, 429 — уже просили за последние 24 часа, 404 —
  // самой записи нет. Живой поллинг списка (useCalls::hasActiveTranscription)
  // подхватит новый transcriptionStage сам, но только когда список его
  // перезапросит — через минуту толкаем кэш явно тем же способом, что и любое
  // другое фоновое обновление в CRM (react-query invalidate).
  const queryClient = useQueryClient();
  const [retranscribing, setRetranscribing] = useState(false);
  const [retranscribeMessage, setRetranscribeMessage] = useState<string | null>(null);
  const [retranscribeError, setRetranscribeError] = useState<string | null>(null);

  async function requestRetranscribe() {
    setRetranscribing(true);
    setRetranscribeError(null);
    setRetranscribeMessage(null);
    try {
      const result = await api<{ queued: boolean }>(`/interactions/${interactionId}/retranscribe`, { method: "POST" });
      if (result.queued) {
        setRetranscribeMessage("Поставлено в очередь, обновится через минуту");
        setTimeout(() => {
          // Предикат, а не голый invalidateQueries() — см. RETRANSCRIBE_INVALIDATE_KEYS
          // выше: без фильтра сбрасывался кэш всего приложения ради одного звонка.
          void queryClient.invalidateQueries({
            predicate: (q) => RETRANSCRIBE_INVALIDATE_KEYS.has(q.queryKey[0] as string),
          });
        }, 60_000);
      }
    } catch (err) {
      if (err instanceof ApiError && (err.status === 429 || err.status === 404)) {
        setRetranscribeError(err.message);
      } else {
        setRetranscribeError(err instanceof Error ? err.message : "Не удалось поставить в очередь");
      }
    } finally {
      setRetranscribing(false);
    }
  }

  if (!hasRecording && !transcript && !analysis) {
    return (
      <Rh2Inline>
        <div className="state">
          <span className="dot" />
          Запись этого разговора не сохранилась.
        </div>
      </Rh2Inline>
    );
  }

  return (
    <Rh2Inline>
      {hasRecording &&
        (canHear ? (
          <CallRecording interactionId={interactionId} createdAt={createdAt} />
        ) : (
          // Запись есть, но звук закрыт (04.09.2026: слушать могут только
          // руководство, СБ и маркетинг) — честно объясняем вместо пустого места
          // или плеера, который ответит 403 при нажатии play.
          <div className="quiet">Запись есть — слушать может руководство, служба безопасности и маркетинг</div>
        ))}

      {analysis && (
        <>
          <div className="rail" aria-label="Шаги разговора">
            <Step done={analysis.greeted} index={1} label="поздоровался" />
            <span className="ln" />
            <Step done={analysis.foundNeed} index={2} label="выяснил потребность" />
            <span className="ln" />
            <Step done={analysis.presentedValue} index={3} label="объяснил ценность" />
            <span className="ln" />
            <Step done={analysis.handledObjection} index={4} label="ответил на возражение" />
            <span className="ln" />
            <Step done={analysis.agreedNextStep} index={5} label="договорился о шаге" />
          </div>

          {analysis.objections.length > 0 && (
            <AnalysisField label="Возражения клиента">{analysis.objections.join(" · ")}</AnalysisField>
          )}
          {analysis.agreements.length > 0 ? (
            <AnalysisField label="Договорились">{analysis.agreements.join(" · ")}</AnalysisField>
          ) : (
            <AnalysisField label="Договорились">Ни о чём. Следующий шаг в разговоре не назван.</AnalysisField>
          )}
          {analysis.coaching && <AnalysisField label="Совет агенту">{analysis.coaching}</AnalysisField>}
          {/* Та же суть по-таджикски — тому, кому русский даётся тяжело
              (владелец 12.08.2026). Показывается только если модель пересказ
              вернула: у русского разговора его нет и быть не должно. */}
          {analysis.summaryTj && <AnalysisField label="Ба тоҷикӣ">{analysis.summaryTj}</AnalysisField>}
        </>
      )}

      {/* Исход/разбор — факты, которые внёс сам агент, а не разбор ИИ. Пропуски
          необязательны намеренно: в хронологии карточки клиента (InteractionTimeline)
          оба уже видны в заголовке строки до раскрытия — см. doc-comment CallDetailsProps. */}
      {outcome && <AnalysisField label="Исход">{INTERACTION_OUTCOME_LABELS[outcome] ?? outcome}</AnalysisField>}
      {notes && <AnalysisField label="Разбор">{notes}</AnalysisField>}

      {!analysis && explainMissingAnalysis && (
        <div className="state">
          <span className="dot" />
          {!transcript
            ? "Разговор не расшифрован."
            : transcript.length < MIN_ANALYZED_TRANSCRIPT_CHARS
              ? "Слишком короткий разговор, разбор не делается."
              : "Разбор ещё готовится."}
        </div>
      )}

      {transcript && (
        <details>
          <summary className="lnk" style={{ cursor: "pointer" }}>
            Расшифровка целиком
          </summary>
          <div style={{ marginTop: 8 }}>
            {/* Кнопка запроса перевода живёт здесь (данные и состояние — в
                CallDetails), а показ оригинала/перевода/рядом и разбор реплик —
                в TranscriptView (см. doc-comment в её файле). */}
            {!translatedRu && !notNeeded && (
              <div className="wrap" style={{ padding: 0, maxWidth: "none", marginBottom: 8 }}>
                <button type="button" onClick={requestTranslation} disabled={translating} className="pill ghost sm">
                  {translating ? "Переводим…" : "Показать перевод на русский"}
                </button>
              </div>
            )}
            {notNeeded && !translatedRu && <div className="note" style={{ marginBottom: 8 }}>Разговор и так по-русски</div>}
            {translateError && (
              <span
                className="chip crit"
                style={{ height: "auto", whiteSpace: "normal", marginBottom: 8, display: "inline-block" }}
              >
                {translateError}
              </span>
            )}
            <TranscriptView
              text={transcript}
              translation={translatedRu}
              agentName={agentName}
              durationSec={recordingDurationSec}
              onRetranscribe={hasRecording ? requestRetranscribe : undefined}
              retranscribing={retranscribing}
            />
            {retranscribeMessage && <div className="note" style={{ marginTop: 8 }}>{retranscribeMessage}</div>}
            {retranscribeError && (
              <span className="chip crit" style={{ height: "auto", whiteSpace: "normal", marginTop: 8, display: "inline-block" }}>
                {retranscribeError}
              </span>
            )}
          </div>
        </details>
      )}
    </Rh2Inline>
  );
}
