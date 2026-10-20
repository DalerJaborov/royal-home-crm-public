import { useState } from "react";
import { Link } from "react-router-dom";
import { useQueuePause, useSetQueuePause, useTelephonyDashboard } from "../hooks/useCalls";
import { DialPadModal } from "../components/DialPad";
import { useCan } from "../lib/permissions";
import { OUTGOING_STATE, formatLiveSeconds } from "../lib/callLive";
import {
  IconClock,
  IconIncoming,
  IconKeypad,
  IconMissed,
  IconOutgoing,
  IconStation,
} from "../components/proto/ProtoIcons";
import { AV_TONES, initials } from "../components/proto/protoAvatar";
import { scrollableRegion } from "../lib/a11y";
import { StatTile } from "../components/ui/StatTile";
import { ScreenTabs } from "../components/ScreenTabs";
import { InboxTabs } from "../components/SectionTabs";

/**
 * ДАШБОРД ТЕЛЕФОНИИ — «как у настоящей АТС» (владелец 11.08.2026).
 *
 * ЗАЧЕМ ОТДЕЛЬНЫЙ ЭКРАН. Состояние телефонии было размазано по системе: связь со
 * станцией проверялась кнопкой в Настройках, внутренние номера лежали в карточках
 * сотрудников, живой звонок видел только тот, кто говорит, счётчики за день
 * приходилось складывать глазами из двух журналов. На вопрос «телефония работает
 * прямо сейчас?» ответа не было нигде — а именно его задают первым.
 *
 * ПОРЯДОК БЛОКОВ — ПО СРОЧНОСТИ ВОПРОСА, а не по красоте: сначала «жива ли
 * станция», потом «что происходит сию секунду», затем «сколько сегодня» и лишь в
 * конце «как настроено». Настройки внизу и ссылками, а не копией переключателей:
 * два места, где меняется одно и то же, неизбежно разъезжаются — здесь показано
 * ДЕЙСТВУЮЩЕЕ значение и путь, где его менять.
 *
 * ОБЛИК — ЭТАЛОН «ROYAL HOME 2026» (перенос 09.09.2026): разметка, имена классов
 * и порядок блоков дословно из `docs/pult/theme-2026/screens/telephony.html`
 * (ветка `docs/pult-theme-07-09`). Запросы, права и поведение звонка не тронуты.
 *
 * ОДИН ЭКРАН НА ДВА РАЗМЕРА (сверка 14.09, шаг 4): отдельный `MobileTelephony`
 * дублировал эту разметку почти один в один (три косметических отличия —
 * короче подписи ссылок и подсказка про запись внизу), своей механики
 * (жестов, отдельных списков) у него не было. Узкую раскладку делает медиазапрос
 * `@media (max-width:820px)` в `theme-2026-mobile-density.css` (плитки 2×2,
 * аппараты в одну колонку); мобильная подсказка внизу — класс `.tel-mobtip`,
 * скрытый на широком экране тем же медиазапросом.
 */
export function Telephony() {
  const can = useCan();
  const allowed = can("calls.transcripts");
  const { data, isLoading, error } = useTelephonyDashboard({ enabled: allowed });
  const [dialOpen, setDialOpen] = useState(false);
  // Полоса «Обращения» — тот же набор, что на Сообщениях/Комментариях/Звонках
  // (docs/archive/menu-wave2-brief-15-09.md). Хук зовём до раннего return ниже.

  if (!allowed) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Телефония</h1>
              <p className="sub">Состояние станции и звонки доступны только администрации.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const live = (data?.live.incoming.length ?? 0) + (data?.live.outgoing.length ?? 0);
  const online = data?.extensions.filter((e) => e.online).length ?? 0;
  const unknownToStation = data?.extensions.filter((e) => !e.knownToStation).length ?? 0;
  // Подпись шапки отвечает на главный вопрос экрана: «станция жива?».
  const subtitle = !data
    ? "Спрашиваем станцию."
    : !data.station.configured
      ? "Станция не настроена."
      : data.station.online
        ? `Станция на связи. Телефонов подключено ${data.station.registered} из ${data.station.total}.`
        : "Нет связи со станцией.";

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Телефония</h1>
            <p className="sub">{subtitle}</p>
          </div>
          {/* Наборщик живёт здесь — на экране станции, а не в архиве разговоров:
              «Звонки» отвечают на вопрос «что было», «Телефония» — «позвонить сейчас». */}
          <div className="acts">
            <button type="button" className="pill ghost" onClick={() => setDialOpen(true)}>
              <IconKeypad />
              Набрать номер
            </button>
          </div>
        </div>

        <InboxTabs />

        {/* Плохие новости — тихой строкой, не карточкой (память 01.09). */}
        {data && ((data.station.configured && !data.station.online) || unknownToStation > 0) && (
          <div className="card tight">
            {data.station.configured && !data.station.online && (
              <div className="quiet crit">
                <span className="dot crit" />
                <span className="txt">
                  Нет связи со станцией: звонки через CRM сейчас не ходят. Если не восстановится за пару минут,
                  сообщите администратору.
                </span>
                <Link className="lnk" to="/calls">
                  Посмотреть звонки
                </Link>
              </div>
            )}
            {unknownToStation > 0 && (
              <div className="quiet warn">
                <span className="dot warn" />
                <span className="txt">
                  {unknownToStation === 1 ? "У одного сотрудника" : `У ${unknownToStation} сотрудников`} номер выдан
                  в CRM, но на самой станции не заведён: звонки на него не дойдут.
                </span>
                <Link className="lnk" to="/settings?tab=channels">
                  Открыть настройки
                </Link>
              </div>
            )}
          </div>
        )}

        <QueuePauseCard />

        {isLoading && (
          <div className="card tight">
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" />
              Спрашиваем станцию
            </div>
          </div>
        )}

        {/* Отказ сервера — словами, а не пустым экраном. Весь контент ниже висит на
            `data &&`: без этой ветки упавший запрос оставлял один заголовок
            «Телефония» и пустоту — то есть экран, который заводили ради вопроса
            «жива ли станция?», на этот вопрос молчал. */}
        {error && !isLoading && (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" />
              {error instanceof Error ? error.message : "Не удалось загрузить состояние телефонии."}
            </div>
          </div>
        )}

        {data && (
          <>
            {/* «Звонки» с 15.09.2026 читает срез из адреса (`?slice=...`,
                Calls.tsx/MobileCalls.tsx) — плитки ведут каждая в свой срез
                вместо голого журнала. Значения те же, что у переключателя
                срезов на самом экране «Звонки» (тип Slice/SupervisorTab). */}
            <div className="tiles">
              <StatTile
                to="/calls?slice=incoming"
                icon={IconIncoming}
                iconTone="var(--aqua)"
                label="Входящих сегодня"
                value={data.today.incoming}
                line="клиенты позвонили сами"
                title="Журнал входящих звонков"
              />
              <StatTile
                to="/calls?slice=all"
                icon={IconOutgoing}
                iconTone="var(--lime)"
                label="Исходящих сегодня"
                value={data.today.outgoing}
                line="агенты звонили сами"
                title="Журнал исходящих звонков"
              />
              <StatTile
                to="/calls?slice=missed"
                icon={IconMissed}
                iconTone="var(--pink)"
                label="Пропущено"
                value={data.today.missed}
                line={data.today.missed > 0 ? "до агентства не дозвонились" : "все звонки приняли"}
                critical={data.today.missed > 0}
                title="Пропущенные звонки"
              />
              <StatTile
                to="/calls?slice=unqualified"
                icon={IconClock}
                iconTone="var(--lav)"
                label="Ждут разбора"
                value={data.today.unqualified}
                line="расшифровка идёт, это занимает минуты"
                title="Входящие без разбора"
              />
            </div>

            <div className="sec-h">
              <h2>Сейчас в эфире</h2>
              <span className="note">{live > 0 ? `${live} на линии, таймеры идут` : "линия свободна"}</span>
            </div>
            <div className="card">
              {live === 0 ? (
                <div className="empty">
                  <span className="ic">
                    <IconStation />
                  </span>
                  <p>Разговоров нет, линия свободна.</p>
                  <button type="button" className="pill ghost" onClick={() => setDialOpen(true)}>
                    Набрать номер
                  </button>
                </div>
              ) : (
                <div className="list">
                  {/**
                   * Живой звонок — строка с аватаром и таймером справа. Таймер вынесен
                   * в отдельную метку `.tick` и моноширинный: он тикает каждую секунду,
                   * и в потоке текста дёргал бы всю строку.
                   */}
                  {data.live.incoming.map((call, i) => {
                    const name = call.clientName ?? call.phone;
                    const tone = AV_TONES[i % AV_TONES.length];
                    return (
                      <div className="live-row" key={call.channelId}>
                        <span
                          className={`av${call.answered ? " ring" : ""}`}
                          style={
                            call.clientName
                              ? ({ background: tone.bg, color: tone.ink } as React.CSSProperties)
                              : ({ background: "var(--track)", color: "var(--muted)" } as React.CSSProperties)
                          }
                        >
                          {call.clientName ? initials(call.clientName) : "?"}
                          <i className={`pres${call.answered ? " on" : ""}`} />
                        </span>
                        <div className="t">
                          <b>
                            {call.clientShortId ? (
                              <Link className="lk" to={`/clients/${call.clientShortId}`}>
                                {name}
                              </Link>
                            ) : (
                              name
                            )}
                          </b>
                          <span>
                            {call.answered
                              ? `Входящий, принял ${call.answeredByName ?? call.answeredBy ?? "оператор"}`
                              : "Входящий, трубку ещё не сняли"}
                          </span>
                        </div>
                        <span className={`chip ${call.answered ? "ok" : "crit"}`}>
                          {call.answered ? "Разговор" : "Ждёт ответа"}
                        </span>
                        <span className={`tick${call.answered ? "" : " crit"}`}>
                          {formatLiveSeconds(call.seconds)}
                        </span>
                      </div>
                    );
                  })}

                  {data.live.outgoing.map((call, i) => {
                    const tone = AV_TONES[(i + data.live.incoming.length) % AV_TONES.length];
                    return (
                      <div className="live-row" key={call.channelId}>
                        <span
                          className="av ring warn"
                          style={{ background: tone.bg, color: tone.ink } as React.CSSProperties}
                        >
                          {initials(call.clientName)}
                          <i className="pres on" />
                        </span>
                        <div className="t">
                          <b>
                            <Link className="lk" to={`/clients/${call.clientShortId}`}>
                              {call.clientName}
                            </Link>
                          </b>
                          <span>Исходящий, звоним клиенту</span>
                        </div>
                        <span className="chip warn">{OUTGOING_STATE[call.state] ?? call.state}</span>
                        <span className="tick warn">{formatLiveSeconds(call.seconds)}</span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="sec-h">
              <h2>Телефоны сотрудников</h2>
              <span className="note">
                на связи {online} из {data.extensions.length}
              </span>
            </div>
            <div className="card">
              {data.extensions.length === 0 ? (
                <div className="empty">
                  <span className="ic">
                    <IconStation />
                  </span>
                  <p>
                    Внутренние номера не выданы. Номер сотруднику выдаётся в Настройках, разделе «Сотрудники»: без
                    него звонки из CRM не работают.
                  </p>
                  <Link className="pill ghost" to="/settings?tab=channels">
                    Открыть настройки
                  </Link>
                </div>
              ) : (
                <div className="devs">
                  {data.extensions.map((ext, i) => {
                    const tone = AV_TONES[i % AV_TONES.length];
                    return (
                      <div className="dev" key={ext.agentId}>
                        <span
                          className="av"
                          style={{ background: tone.bg, color: tone.ink } as React.CSSProperties}
                        >
                          {initials(ext.fullName)}
                          <i className={`pres${ext.online ? " on" : ""}`} />
                        </span>
                        <div className="t">
                          <b>{ext.fullName}</b>
                          <span>Номер {ext.extension}</span>
                        </div>
                        {/* Разница «не подключён» и «нет на станции» неочевидна, а стоит
                            дорого: во втором случае номер выдан в CRM, но на АТС его не
                            существует — звонки на него уходят в никуда. */}
                        <span className={`chip ${ext.online ? "ok" : ext.knownToStation ? "mute" : "crit"}`}>
                          {ext.online ? "на связи" : ext.knownToStation ? "не подключён" : "нет на станции"}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              {unknownToStation > 0 && (
                <div className="quiet" style={{ marginTop: 12 }}>
                  <span className="dot" />
                  <span className="txt">
                    «Нет на станции» значит, что номер выдан в CRM, но на самой АТС не заведён: звонки на него не
                    дойдут.
                  </span>
                  <Link className="lnk" to="/settings?tab=channels">
                    Изменить
                  </Link>
                </div>
              )}
            </div>

            <div className="sec-h">
              <h2>Как настроено сейчас</h2>
              <span className="note">меняется в настройках, здесь только показано</span>
            </div>
            <div className="card">
              <div className="tbl-wrap" {...scrollableRegion("Настройки телефонии")}>
                <table className="tbl">
                  <tbody>
                    <tr>
                      <td>Принимают входящие</td>
                      <td className="num">
                        {data.settings.operators > 0
                          ? `${data.settings.operators} сотр.`
                          : "все, кто разбирает ничейные"}
                      </td>
                    </tr>
                    <tr>
                      <td>Уведомление о звонке</td>
                      <td className="num">{data.settings.pushEnabled ? "включено" : "выключено"}</td>
                    </tr>
                    <tr>
                      <td>Окно оператора</td>
                      <td className="num">{data.settings.panelEnabled ? "показывается" : "выключено"}</td>
                    </tr>
                    <tr>
                      <td>Часы приёма</td>
                      <td className="num">
                        {data.settings.hoursEnabled
                          ? `с ${data.settings.hoursStart} до ${data.settings.hoursEnd}`
                          : "круглосуточно"}
                      </td>
                    </tr>
                    <tr>
                      <td>Карточка по незнакомому номеру</td>
                      <td className="num">{data.settings.autoCreateClient ? "заводится" : "не заводится"}</td>
                    </tr>
                    {/* Куда звонок идёт ПЕРВЫМ делом — самая частая причина «звонки не
                        приходят»: приём переведён на аппарат, а операторы ждут звонков,
                        которых не будет. */}
                    <tr>
                      <td>Входящий идёт</td>
                      <td className="num">
                        {data.settings.primaryTarget === "extension"
                          ? `прямо на аппарат ${data.settings.primaryExtension ?? ""}`.trim()
                          : "операторам в очередь"}
                      </td>
                    </tr>
                    <tr>
                      <td>Переадресация, когда никто не берёт</td>
                      <td className="num">{data.settings.forwardPhone ?? "не задана"}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="wrap" style={{ marginTop: 16 }}>
                <Link className="pill ghost sm" to="/settings?tab=channels">
                  Изменить в настройках
                </Link>
              </div>
            </div>

            {/* Подсказка мобильная: что происходит с каждым звонком, спрашивают
                именно с телефона. На широком экране скрыта `.tel-mobtip`
                (theme-2026-mobile-density.css) — не JS-ветвление, чтобы не
                держать два дерева разметки ради одной строки. */}
            <div className="card tight tel-mobtip">
              <div className="quiet">
                <span className="dot ok" />
                <span className="txt">Звонки идут через офисную линию, запись и итог появляются сами.</span>
              </div>
            </div>
          </>
        )}

        {dialOpen && <DialPadModal onClose={() => setDialOpen(false)} />}
      </div>
    </div>
  );
}

/**
 * «Я НА МЕСТЕ» / «ОТОШЁЛ» — единственная кнопка, которой оператор управляет самим
 * приёмом звонков.
 *
 * Пока он числится в очереди, станция звонит ему и на обеде, и в дороге: клиент
 * слушает гудки, а потом попадает в тишину. Снять себя человек мог только через
 * панель FreePBX, доступа к которой у него нет.
 *
 * Карточки нет вовсе, когда управление станцией не настроено или сотрудник не
 * числится в очереди: кнопка, которая нажимается и ничего не делает, хуже её
 * отсутствия. Причина при этом показывается — иначе непонятно, куда она делась.
 *
 * Облик — блок `.solve` эталона (`telephony.html`, «Приём звонков»).
 */
function QueuePauseCard() {
  const { data: state } = useQueuePause();
  const setPaused = useSetQueuePause();
  if (!state) return null;

  if (!state.available) {
    /**
     * Молчим про «вы не в очереди» — для директора это норма, а не проблема, — и
     * про ненастроенное управление станцией: пока владелец не завёл доступ, эта
     * плашка висела бы у всех как жалоба на то, чего никто не включал. Остаётся
     * единственный случай, ради которого блок и нужен: доступ настроен, а станция
     * не отвечает прямо сейчас.
     */
    if (!state.error || /не числитесь|не настроено/.test(state.error)) return null;
    return (
      <div className="card tight">
        <div className="quiet">
          <span className="dot" />
          <span className="txt">Управление приёмом звонков недоступно: {state.error}</span>
        </div>
      </div>
    );
  }

  const paused = !!state.paused;
  return (
    <div className="card tight">
      <div className="solve">
        <span
          className="av"
          style={
            paused
              ? ({ background: "var(--warn-bg)", color: "var(--warn)" } as React.CSSProperties)
              : ({ background: "var(--lime)", color: "var(--lime-ink)" } as React.CSSProperties)
          }
        >
          {paused ? "II" : "ОК"}
          <i className={`pres${paused ? " away" : " on"}`} />
        </span>
        <span className="t">
          <b>{paused ? "Вы отошли." : "Вы принимаете звонки."}</b>{" "}
          {paused
            ? "Станция не звонит вам по входящим, клиентов принимают остальные операторы."
            : `Входящие приходят вам${state.queue ? `, очередь ${state.queue}` : ""}.`}
        </span>
        <span className="acts">
          <button
            type="button"
            className="pill sm"
            onClick={() => setPaused.mutate(!paused)}
            disabled={setPaused.isPending}
          >
            {setPaused.isPending ? "Меняю…" : paused ? "Я на месте" : "Отошёл"}
          </button>
        </span>
      </div>
      {setPaused.isError && (
        <div className="quiet crit">
          <span className="dot crit" />
          <span className="txt">
            {setPaused.error instanceof Error ? setPaused.error.message : "Станция не ответила"}
          </span>
        </div>
      )}
    </div>
  );
}
