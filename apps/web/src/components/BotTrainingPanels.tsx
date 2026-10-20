import { useState, type CSSProperties } from "react";
import {
  loadMoreTrainingSamples,
  useDecideTraining,
  useDeleteTrainingSample,
  useGuardStats,
  useNextTrainingQuestion,
  useTrainingSamples,
  useUpdateTrainingSample,
  type TrainingSample,
} from "../hooks/useBotTraining";
import { ApiError } from "../lib/apiError";
import { relativeTime } from "../lib/format";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./Switch";
import { resolveNextCursor } from "../lib/resolveNextCursor";

/**
 * Общие для десктопа и телефона панели экрана «Тренировка»
 * (pages/BotTraining.tsx, один экран на обе ширины с 10.09.2026) — вынесены
 * сюда исторически, чтобы страница и мобильный компонент не импортировали
 * друг друга; отдельного мобильного компонента больше нет, но разбиение
 * оставлено, TrainingSession и GuardStatsPanel — самостоятельные секции
 * экрана в терминах макета.
 *
 * ОБЛИК — тема «Royal Home 2026», эталон tpl-bot-training
 * (docs/pult/theme-2026/artifact-ff1d9d17-pult-director.html): вопрос и
 * варианты — `.qa` с блоками `.ask`/`.ans`, подписи `.k2`, текст `.body2` и
 * `.sample`, счётчики фильтров — `.bars`/`.b`/`.nm3`/`.tr`/`.vl`, состояния —
 * `.state`/`.state.err`/`.empty` как у соседних экранов.
 */

/**
 * Счётчики фильтров ответа за N дней (useGuardStats → GET /bot-training/guard-stats):
 * старые «чинят реплику бота» (повтор приветствия, переспрошенный вопрос…) и новые
 * «нецелевой лид» (география, услуги, земля и коммерция…), добавленные 30.08.2026.
 * Раньше это можно было увидеть только прямым запросом к БД — владелец попросил
 * вывести на экран.
 */
export function GuardStatsPanel() {
  const { data, isLoading, isError } = useGuardStats();
  const max = data?.totals[0]?.count ?? 0;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Срабатывания фильтров за {data?.days ?? 14} дней</h2>
        <span className="note">Сколько раз фильтр исправил ответ или отсеял нецелевой лид</span>
      </div>

      {isLoading ? (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем статистику
        </div>
      ) : isError ? (
        <div className="state err">
          <span className="dot crit" /> Не удалось загрузить статистику.
        </div>
      ) : data && data.totals.length === 0 ? (
        <div className="empty">
          <p>За последние {data.days} дней ни один фильтр не сработал.</p>
        </div>
      ) : (
        data && (
          <>
            <div className="bars">
              {data.totals.map((row) => (
                <div className="b" key={row.guard}>
                  <span className="nm3" title={row.label}>
                    {row.label}
                  </span>
                  <span className="tr">
                    <i style={{ "--v": max > 0 ? row.count / max : 0 } as CSSProperties} />
                  </span>
                  <span className="vl">{row.count}</span>
                </div>
              ))}
            </div>
            <div className="quiet" style={{ marginTop: 12 }}>
              <span className="dot" />
              <span className="txt">
                Каждое срабатывание значит, что карточка клиенту не завелась зря или ответ ушёл исправленным.
              </span>
            </div>
          </>
        )
      )}
    </section>
  );
}

/**
 * «Ждут разбора» — в макете (artifact-c99db05f, renderBotTraining) список
 * случаев с числом рядом с заголовком. Разведка 14.09.2026: сервер такого
 * списка не отдаёт — /bot-training/next каждый раз заново сканирует последние
 * переписки (ai/training.ts, scanCandidates) и подбирает ОДИН случайный
 * вопрос, а не читает и не считает очередь. Списка и счётчика без нового
 * эндпоинта не появится (это шаг 5, не эта задача) — честная тихая строка
 * вместо выдуманного числа.
 */
export function PendingCasesPanel() {
  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Ждут разбора</h2>
      </div>
      <div className="quiet">
        <span className="dot" />
        <span className="txt">Нет данных: очередь случаев сервер не отдаёт, каждый вопрос ниже подбирается заново.</span>
      </div>
    </section>
  );
}

export function TrainingSession({ canDecide }: { canDecide: boolean }) {
  const [trainedCount, setTrainedCount] = useState(0);
  const [customText, setCustomText] = useState("");
  const [savedAgentText, setSavedAgentText] = useState<string | null>(null);

  const { data, isFetching, isError, error, refetch } = useNextTrainingQuestion(true);
  const decide = useDecideTraining();

  const question = data && !data.done ? data : null;

  function next() {
    setCustomText("");
    setSavedAgentText(null);
    decide.reset();
    void refetch();
  }

  function pick(variant: string, index: number) {
    if (!question?.clientText) return;
    decide.mutate(
      {
        clientText: question.clientText,
        channel: question.channel,
        variants: question.variants,
        chosenIndex: index,
      },
      {
        onSuccess: () => {
          setSavedAgentText(variant);
          setTrainedCount((n) => n + 1);
        },
      },
    );
  }

  function saveCustom() {
    if (!question?.clientText || !customText.trim()) return;
    decide.mutate(
      { clientText: question.clientText, channel: question.channel, customText: customText.trim() },
      {
        onSuccess: () => {
          setSavedAgentText(customText.trim());
          setTrainedCount((n) => n + 1);
        },
      },
    );
  }

  return (
    <>
      {/* Счётчик «N пар сохранено» — в макете это `.chip` в шапке `.pg-h .acts`
          со словами «сегодня». Честно за сегодня посчитать нельзя: листинга
          сохранённых образцов эндпоинт не отдаёт (см. карточку «Сохранённые
          примеры манеры» ниже) — считаем то, что реально знаем: сколько пар
          сохранил СЕЙЧАС этот человек в этом заходе на экран. Чип живёт здесь,
          а не в шапке страницы: только тут известно значение trainedCount. */}
      {trainedCount > 0 && (
        <div className="card tight">
          <div className="quiet">
            <span className="dot ok" />
            <span className="txt">
              Сохранено в этом заходе: {trainedCount} {pluralTrained(trainedCount)}.
            </span>
          </div>
        </div>
      )}

      <section className="card">
        <div className="sec-h stack">
          <h2>Вопрос клиента</h2>
          {question?.channel && <span className="note">{channelLabel(question.channel)}</span>}
        </div>

        {isFetching && !question ? (
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Подбираем вопрос и придумываем варианты
          </div>
        ) : isError && !isFetching ? (
          <div className="state err">
            <span className="dot crit" />
            {error instanceof ApiError ? error.message : "Вопрос не загрузился. Проверьте связь."}
            <button type="button" className="lk" style={{ color: "inherit", textDecoration: "underline" }} onClick={() => void refetch()}>
              Попробовать снова
            </button>
          </div>
        ) : !isFetching && !isError && data?.done ? (
          <div className="empty">
            <p>Вопросов для тренировки пока нет.</p>
            <span className="sub">Все недавние вопросы клиентов уже стали образцами манеры. Загляните позже.</span>
          </div>
        ) : question ? (
          <div className="qa">
            <div className="ask">
              <span className="k2">Клиент спросил</span>
              <div className="body2">
                <p>«{question.clientText}»</p>
              </div>
            </div>

            {savedAgentText ? (
              <div className="ans">
                <span className="k2">Сохранено</span>
                <div className="body2">
                  <div className="sample">{savedAgentText}</div>
                  <div className="wrap" style={{ marginTop: 12 }}>
                    <span className="txt">
                      {decide.data?.duplicate
                        ? "Такая пара уже была сохранена раньше, ничего страшного."
                        : "Сохранено как пример манеры бота."}
                    </span>
                    <button type="button" className="pill sm" onClick={next}>
                      Дальше
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <>
                {question.variants?.map((variant, index) => (
                  <div className="ans" key={index}>
                    <span className="k2">Вариант {index + 1}</span>
                    <div className="body2">
                      <div className="sample">{variant}</div>
                      <div className="wrap" style={{ marginTop: 12 }}>
                        {canDecide && (
                          <button
                            type="button"
                            className={index === 0 ? "pill sm" : "pill ghost sm"}
                            onClick={() => pick(variant, index)}
                            disabled={decide.isPending}
                          >
                            Этот лучше
                          </button>
                        )}
                        {question.groundedIndex === index ? (
                          (question.groundedSources?.length ?? 0) > 0 ? (
                            <span className="chip">
                              <span className="dot gold" />
                              Найдено живым поиском:{" "}
                              {question.groundedSources!.map((s, i) => (
                                <a
                                  key={i}
                                  href={s.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  style={{ marginLeft: i > 0 ? 6 : 4 }}
                                >
                                  {s.title || s.url}
                                </a>
                              ))}
                            </span>
                          ) : (
                            <span className="note" style={{ fontSize: "var(--fs-12)", color: "var(--faint)" }}>
                              Найдено живым поиском, источники не приложены — проверьте факт сами
                            </span>
                          )
                        ) : (
                          index === 0 && (
                            <span className="note" style={{ fontSize: "var(--fs-12)", color: "var(--faint)" }}>
                              Источники не приложены, проверьте факт сами
                            </span>
                          )
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {canDecide && (
                  <div className="ans">
                    <span className="k2">Или свой</span>
                    <div className="body2">
                      <label className="vh" htmlFor="own-training-answer">
                        Ваш вариант ответа
                      </label>
                      <textarea
                        id="own-training-answer"
                        value={customText}
                        onChange={(e) => setCustomText(e.target.value)}
                        maxLength={2000}
                        placeholder="Как ответили бы вы…"
                      />
                      <div className="wrap" style={{ marginTop: 12 }}>
                        <button
                          type="button"
                          className="pill ghost"
                          onClick={saveCustom}
                          disabled={!customText.trim() || decide.isPending}
                        >
                          Сохранить свой вариант
                        </button>
                        <button type="button" className="pill ghost" onClick={next}>
                          Дальше без ответа
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {decide.isError && (
                  <div className="quiet crit">
                    <span className="dot crit" />
                    <span className="txt">
                      {decide.error instanceof ApiError ? decide.error.message : "Не удалось сохранить, попробуйте ещё раз."}
                    </span>
                  </div>
                )}
              </>
            )}
          </div>
        ) : null}

        {question && !savedAgentText && (
          <div className="quiet" style={{ marginTop: 8 }}>
            <span className="dot ok" />
            <span className="txt">Пара сохраняется как пример манеры, а не как готовый ответ: бот не будет повторять её дословно.</span>
          </div>
        )}
      </section>

      {!canDecide && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">У вас нет права сохранять образцы, можно только смотреть вопросы.</span>
        </div>
      )}
    </>
  );
}

/** Откуда взялся образец манеры (StyleExample.source) — те же три вида, что
 *  пишет styleLearning.ts: тренировка на этом экране, разовый импорт истории
 *  переписок, перехват живого диалога сотрудником. */
const SOURCE_LABELS: Record<string, string> = {
  TRAINING: "тренировка",
  HISTORY: "из истории",
  TAKEOVER: "перехват диалога",
};

/**
 * «Сохранённые примеры манеры» — список последних образцов StyleExample
 * (GET /bot-training/samples, до 50, свежие сверху; только `enabled: true` —
 * ровно то, что сейчас реально участвует в промте бота).
 */
export function SavedTrainingSamplesSection() {
  const { data, isLoading, isError } = useTrainingSamples();
  const update = useUpdateTrainingSample();
  const remove = useDeleteTrainingSample();
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<TrainingSample | null>(null);
  // Догруженные страницы поверх первой — тот же приём, что у ленты «Обучение
  // бота» (BotTab.tsx): курсор — id последнего показанного образца, сброс
  // после любой правки, когда сервер отдаёт свежую первую страницу заново.
  const [extra, setExtra] = useState<TrainingSample[]>([]);
  // undefined — догрузки ещё не было; null — последняя страница вернула конец (см. resolveNextCursor).
  const [extraCursor, setExtraCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);

  // Сброс хвоста, когда пришла свежая первая страница (аудит 02.10.2026): до
  // этого обещанный выше сброс не делался вовсе, и хвост, догруженный от
  // старого курсора, висел поверх новой первой страницы — с дублями, а образец,
  // вытесненный с первой страницы новым, пропадал между ними. Сравнение по
  // ссылке на массив: React Query отдаёт новый массив на каждый ответ.
  const [baseRef, setBaseRef] = useState(data?.samples);
  if (data?.samples !== baseRef) {
    setBaseRef(data?.samples);
    setExtra([]);
    setExtraCursor(undefined);
  }

  const baseSamples = data?.samples ?? [];
  // Склейка по id — на случай, если ответ хвоста разошёлся с первой страницей.
  const samples = [...baseSamples, ...extra].filter(
    (x, i, all) => all.findIndex((y) => y.id === x.id) === i
  );
  const nextCursor = resolveNextCursor(extraCursor, data?.nextCursor);

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await loadMoreTrainingSamples(nextCursor);
      setExtra((prev) => [...prev, ...page.samples]);
      setExtraCursor(page.nextCursor);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось загрузить ещё");
    } finally {
      setLoadingMore(false);
    }
  }

  function toggle(sample: TrainingSample, enabled: boolean) {
    setError(null);
    // Выключенный образец уходит из выдачи (фильтр enabled: true) — убираем
    // сразу и из локального хвоста, а не только из первой страницы.
    setExtra((prev) => prev.filter((x) => x.id !== sample.id));
    update.mutate(
      { id: sample.id, enabled },
      { onError: (err) => setError(err instanceof Error ? err.message : "Не удалось выключить образец") }
    );
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    setError(null);
    setExtra((prev) => prev.filter((x) => x.id !== id));
    remove.mutate(id, {
      onError: (err) => setError(err instanceof Error ? err.message : "Не удалось удалить образец"),
    });
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Сохранённые примеры манеры</h2>
        <span className="note">Список последних образцов</span>
      </div>

      {isLoading ? (
        <div className="state">
          <span className="sk w40" />
          <span className="sk w22" /> Загружаем список
        </div>
      ) : isError ? (
        <div className="state err">
          <span className="dot crit" /> Не удалось загрузить список.
        </div>
      ) : samples.length === 0 ? (
        <div className="empty">
          <p>Пока ни одного образца не сохранено.</p>
        </div>
      ) : (
        <div className="list">
          {samples.map((s) => (
            <div className="row" key={s.id}>
              <div className="t">
                <b title={s.clientText}>«{s.clientText}»</b>
                <span title={s.agentText}>{s.agentText}</span>
              </div>
              {/* Пометка «манера» (вкладка «Манера») — в отличие от «суть» на
                  правилах вкладки «Правила»: это образец ТОНА, не готовый ответ. */}
              <span className="chip mute">манера</span>
              <span className="chip mute">{SOURCE_LABELS[s.source] ?? s.source}</span>
              {s.channel && <span className="chip mute only-wide">{channelLabel(s.channel)}</span>}
              <span className="meta only-wide">{relativeTime(s.createdAt)}</span>
              <Switch on={true} onToggle={() => toggle(s, false)} label={`Образец манеры: «${s.clientText}»`} />
              <button
                className="pill ghost sm"
                type="button"
                onClick={() => setPendingDelete(s)}
                disabled={remove.isPending}
                aria-label={`Удалить образец: «${s.clientText}»`}
                title="Удалить образец"
              >
                Удалить
              </button>
            </div>
          ))}
        </div>
      )}

      {data && data.total > samples.length && (
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Показаны {samples.length} образцов из {data.total}.
          </span>
        </div>
      )}
      {nextCursor && (
        <div className="wrap" style={{ marginTop: "var(--s2)" }}>
          <button className="pill ghost sm" type="button" onClick={() => void loadMore()} disabled={loadingMore}>
            {loadingMore ? "Загружаем…" : "Показать ещё"}
          </button>
        </div>
      )}
      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}

      {pendingDelete && (
        <ConfirmDialog
          title="Удалить образец манеры?"
          description="Образец исчезнет из промта бота необратимо. Чтобы бот просто перестал на него опираться, хватит выключателя."
          confirmLabel="Удалить"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={confirmDelete}
        />
      )}
    </section>
  );
}

function pluralTrained(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "пара сохранена";
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return "пары сохранены";
  return "пар сохранено";
}

function channelLabel(channel: string): string {
  const names: Record<string, string> = {
    WHATSAPP: "WhatsApp",
    INSTAGRAM: "Instagram",
    FACEBOOK: "Messenger",
    TELEGRAM: "Telegram",
  };
  return names[channel] ?? channel;
}
