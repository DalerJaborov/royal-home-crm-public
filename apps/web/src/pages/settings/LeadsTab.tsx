import { useState } from "react";
import { useServerSyncedFields } from "../../hooks/useServerSyncedForm";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";
import { KeywordTags } from "../../components/ui/KeywordTags";
import { NumberRow, SaveRow } from "../../components/settings/SettingsRows";
import { Link } from "react-router-dom";
import {
  SHOWING_CONFIRM_ON_TEXT,
  ownPropertyThresholdNote,
  releaseEffectiveOn,
  releaseToggleBody,
  showingConfirmBlockedBy,
} from "../../lib/settingsDependencies";

/**
 * Вкладка «Лиды» — кому достаётся клиент и что агент видит в уведомлении.
 *
 * Собрана 11.08.2026 под требование владельца: «все эти настройки должны быть
 * прописаны в настройках и работать, чтобы не было сложностей с кодом». Поэтому
 * здесь нет ни одного числа, зашитого в код: порог совпадения, окно показов,
 * потолок своих лидов и срок жизни маркера действия — всё правится руками.
 *
 * Правило тумблеров (выстрадано 11.08.2026): подпись описывает ТЕКУЩЕЕ положение,
 * а не одно из двух, и меняется вместе с тумблером. Тумблер — общий `SwitchRow`,
 * своих копий не заводить.
 *
 * Разметка — дословно эталон темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/settings.html, вкладка «Лиды» показана целиком):
 * каждый блок — карточка `.card` с шапкой `.sec-h.stack`, каждое число — строка
 * `.mod` с полем `.nf`, каждый рубильник — строка `.mod` с тумблером `.tgl`.
 */

export function LeadsTab({ limitsTask = false }: { limitsTask?: boolean } = {}) {
  const { data: settings, isError, error, refetch } = useSettings();
  const updateSettings = useUpdateSettings();
  const [threshold, setThreshold] = useState("");
  const [shownDays, setShownDays] = useState("");
  const [ttl, setTtl] = useState("");
  const [messageThrottle, setMessageThrottle] = useState("");
  const [saved, setSaved] = useState(false);
  const [savedNotify, setSavedNotify] = useState(false);
  // Щиток занятости (21.08.2026) — своя форма и своя кнопка «Сохранено»,
  // число правится отдельно от тумблера самого щитка. Пул «ничьих» (второе
  // число здесь же) удалён целиком 17.09.2026 — см. LeadsTab ниже.
  const [shieldAfterMinutes, setShieldAfterMinutes] = useState("");
  const [savedOccupancy, setSavedOccupancy] = useState(false);
  // Слова-признаки конфликта в причине передачи OTHER (22.08.2026) — список
  // сохраняется отдельно от остальных форм, своей кнопкой.
  const [conflictKeywords, setConflictKeywords] = useState<string[]>([]);
  const [savedConflictKeywords, setSavedConflictKeywords] = useState(false);
  // «Взвешенные слоты» лимита (план владельца 20-21.08.2026) — свои поля и своя
  // кнопка: тумблер включается отдельно от правки самих весов.
  const [weightFresh, setWeightFresh] = useState("");
  const [weightAfterShowing, setWeightAfterShowing] = useState("");
  const [weightThinking, setWeightThinking] = useState("");
  const [savedSlotWeights, setSavedSlotWeights] = useState(false);
  // Реактивация старых клиентов пачкой (Пачка 12, 11.09.2026) — тумблер
  // сохраняется сразу (правило тумблеров), дни/размер пачки/шаблон — своей формой.
  const [reactivationAfterDays, setReactivationAfterDays] = useState("");
  const [reactivationBatchSize, setReactivationBatchSize] = useState("");
  const [reactivationTemplate, setReactivationTemplate] = useState("");
  const [savedReactivation, setSavedReactivation] = useState(false);

  // Поля перезаливаются с сервера, только если сервер поменял именно их и
  // человек их не трогал (F3, 02.10.2026): на этой вкладке ~11 мгновенных
  // тумблеров и 6 отдельных форм, и каждый из них раньше стирал набранное рядом.
  useServerSyncedFields(
    settings && {
      threshold: String(settings.ownPropertyMatchThreshold ?? 90),
      shownDays: String(settings.ownPropertyShownWindowDays ?? 30),
      ttl: String(settings.pushActionTtlMinutes ?? 30),
      messageThrottle: String(settings.pushMessageThrottleMinutes ?? 3),
      shieldAfterMinutes: String(settings.agentOccupancyShieldAfterMinutes ?? 30),
      conflictKeywords: settings.transferConflictKeywords ?? [],
      weightFresh: String(settings.leadSlotWeightFreshPercent ?? 100),
      weightAfterShowing: String(settings.leadSlotWeightAfterShowingPercent ?? 50),
      weightThinking: String(settings.leadSlotWeightThinkingPercent ?? 25),
      reactivationAfterDays: String(settings.reactivationAfterDays ?? 60),
      reactivationBatchSize: String(settings.reactivationBatchSize ?? 20),
      reactivationTemplate: settings.reactivationMessageTemplate ?? "",
    },
    {
      threshold: [threshold, setThreshold],
      shownDays: [shownDays, setShownDays],
      ttl: [ttl, setTtl],
      messageThrottle: [messageThrottle, setMessageThrottle],
      shieldAfterMinutes: [shieldAfterMinutes, setShieldAfterMinutes],
      conflictKeywords: [conflictKeywords, setConflictKeywords],
      weightFresh: [weightFresh, setWeightFresh],
      weightAfterShowing: [weightAfterShowing, setWeightAfterShowing],
      weightThinking: [weightThinking, setWeightThinking],
      reactivationAfterDays: [reactivationAfterDays, setReactivationAfterDays],
      reactivationBatchSize: [reactivationBatchSize, setReactivationBatchSize],
      reactivationTemplate: [reactivationTemplate, setReactivationTemplate],
    }
  );

  /**
   * Пустой экран вместо объяснения (аудит 22.08.2026, раунд 6): при отказе
   * запроса вкладка «Лиды» рисовала РОВНО НИЧЕГО — ни заголовка, ни ошибки, ни
   * загрузки. Человек видел пустое место и не понимал, сломалось или так надо.
   */
  if (!settings) {
    return (
      <div className="card tight">
        {isError ? (
          <div className="state err">
            <span className="dot crit" />
            {error instanceof Error ? error.message : "Не удалось загрузить настройки лидов"}{" "}
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
          <div className="state">
            <span className="sk w40" />
            <span className="sk w22" /> Загружаем настройки
          </div>
        )}
      </div>
    );
  }

  const priorityOn = settings.ownPropertyPriorityEnabled;
  const shownOn = settings.ownPropertyShownExceptionEnabled;
  /**
   * «Предлагать освободить место» сервер проверяет ДВУМЯ полями
   * (lib/leadAccept.ts: overLimitEnabled && releaseEnabled), а тумблер на экране
   * есть только у второго — ownPropertyOverLimitEnabled своего тумблера лишился
   * 11.09.2026 вместе с «Потолком лидов по своим объектам». До 28.09.2026 скрытое
   * поле молча ВЫКЛЮЧАЛО видимый тумблер (disabled) — владелец видел серый
   * переключатель без объяснения. Теперь тумблер показывает итог обоих полей, а
   * включение поднимает оба (releaseToggleBody). Серверное условие не тронуто.
   */
  const releaseOn = releaseEffectiveOn(settings);
  const pushActionsOn = settings.pushLeadActionsEnabled;
  const limit = settings.leadActiveLimit;
  const weightedSlotsOn = settings.weightedLeadSlotsEnabled;
  const shieldOn = settings.agentOccupancyShieldEnabled;
  const reactivationOn = settings.reactivationEnabled;

  async function handleSaveNumbers(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    await updateSettings.mutateAsync({
      ownPropertyMatchThreshold: Number(threshold),
      ownPropertyShownWindowDays: Number(shownDays),
      pushActionTtlMinutes: Number(ttl),
    });
    setSaved(true);
  }

  async function handleSaveSlotWeights(e: React.FormEvent) {
    e.preventDefault();
    setSavedSlotWeights(false);
    await updateSettings.mutateAsync({
      leadSlotWeightFreshPercent: Number(weightFresh),
      leadSlotWeightAfterShowingPercent: Number(weightAfterShowing),
      leadSlotWeightThinkingPercent: Number(weightThinking),
    });
    setSavedSlotWeights(true);
  }

  async function handleSaveOccupancy(e: React.FormEvent) {
    e.preventDefault();
    setSavedOccupancy(false);
    await updateSettings.mutateAsync({
      agentOccupancyShieldAfterMinutes: Number(shieldAfterMinutes),
    });
    setSavedOccupancy(true);
  }

  async function handleSaveReactivation(e: React.FormEvent) {
    e.preventDefault();
    setSavedReactivation(false);
    await updateSettings.mutateAsync({
      reactivationAfterDays: Number(reactivationAfterDays),
      reactivationBatchSize: Number(reactivationBatchSize),
      reactivationMessageTemplate: reactivationTemplate,
    });
    setSavedReactivation(true);
  }

  async function handleSaveConflictKeywords() {
    setSavedConflictKeywords(false);
    await updateSettings.mutateAsync({ transferConflictKeywords: conflictKeywords });
    setSavedConflictKeywords(true);
  }

  async function handleSaveNotify(e: React.FormEvent) {
    e.preventDefault();
    setSavedNotify(false);
    await updateSettings.mutateAsync({
      pushMessageThrottleMinutes: Number(messageThrottle),
    });
    setSavedNotify(true);
  }

  return (
    <>
      <section className="card">
        <div className="sec-h stack">
          <h2>Свой объект: свой клиент</h2>
          <span className="note">Когда лид уходит хозяину подходящего объекта мимо очереди</span>
        </div>
        <p className="sub" style={{ marginBottom: "var(--s3)" }}>
          Агент, который сам съездил к собственнику, отснял фото и видео и завёл объект, получает клиента по
          этому объекту вне общей очереди. Сам процент комиссии правится в «Деньгах».
        </p>
        <div className="quiet" style={{ marginBottom: "var(--s3)" }}>
          <span className="dot" />
          <span className="txt">Веса шкалы — во вкладке «Подбор объектов»</span>
        </div>

        <SwitchRow
          title="Отдавать клиента хозяину подходящего объекта"
          on={priorityOn}
          onToggle={() => updateSettings.mutate({ ownPropertyPriorityEnabled: !priorityOn })}
          hint={
            priorityOn
              ? `Если запрос клиента набирает с объектом агента не меньше ${threshold || 90} из 100 по шкале «Подбора объектов», клиент уходит этому агенту — очередь по KPI при этом не смотрится.`
              : "Клиенты распределяются только по общей очереди, объекты агента ни на что не влияют."
          }
        />

        <SwitchRow
          title="Бот уже показал объект: отдавать безусловно"
          on={shownOn}
          onToggle={() => updateSettings.mutate({ ownPropertyShownExceptionEnabled: !shownOn })}
          hint={
            shownOn
              ? `Если бот отправил клиенту ссылку или фотографии объекта за последние ${shownDays || 30} дн., клиент уходит хозяину этого объекта независимо от совпадения и от загрузки.`
              : "Показанный ботом объект на распределение не влияет — клиент пойдёт по общему правилу выше."
          }
        />

        <form onSubmit={handleSaveNumbers}>
          <NumberRow
            label="Порог совпадения"
            unit="из 100"
            min={0}
            max={100}
            value={threshold}
            onChange={setThreshold}
            hint="С какого балла совпадения запроса клиента и объекта лид уходит хозяину мимо очереди. Балл — шкала вкладки «Подбор объектов»: база за пройденный фильтр плюс район, попадание в желаемое место на карте, комнаты и бюджет; бонус горячему здесь не начисляется. Площадь и этаж в балл не входят — они только отсеивают на фильтре. 90 — решение владельца 09.09.2026. Ниже 60 очередь по KPI фактически перестанет работать."
          />
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              {ownPropertyThresholdNote(Number(threshold) || 0, {
                base: settings.matchScoreBase ?? 40,
                district: settings.matchScoreDistrict ?? 25,
                rooms: settings.matchScoreRooms ?? 20,
                budget: settings.matchScoreBudget ?? 15,
                distance: settings.matchScoreDistance ?? 25,
              })}
            </span>
            <Link className="lnk" to="/settings?tab=matching">
              Веса шкалы
            </Link>
          </div>
          <NumberRow
            label="Учитывать показы бота за"
            unit="дней"
            min={1}
            max={365}
            value={shownDays}
            onChange={setShownDays}
            hint="Как далеко назад смотреть, что бот показывал клиенту этот объект. Не путать с недельной защитой от повторной отправки тех же фотографий — это разное."
          />
          <p className="sub" style={{ margin: "var(--s3) 0" }}>
            Лид по своему объекту всегда уходит агенту объекта, без лимита (решение
            владельца 11.09.2026) — потолка сверх лимита больше нет ни в каком виде.
          </p>
          <NumberRow
            label="Срок жизни кнопок в уведомлении"
            unit="минут"
            min={5}
            max={60}
            value={ttl}
            onChange={setTtl}
            hint="Сколько действуют кнопки «Принять» и «Отклонить» в шторке. После этого уведомление остаётся, но кнопки уже ничего не делают — открыть карточку по-прежнему можно."
          />
          <SaveRow pending={updateSettings.isPending} saved={saved} />
        </form>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Занятость агента в раздаче</h2>
          <span className="note">Кому не давать новых, пока он занят</span>
        </div>
        <p className="sub" style={{ marginBottom: "var(--s3)" }}>
          Мозговой штурм 21.08.2026 — вероятный корень случая с Нурмухаммадом 18.08.2026: агенту пришёл лид с
          тикающим таймером посреди показа, он физически не мог ни принять его, ни позвонить вовремя. Из-за
          этого автопередачу при непозвонившем агенте выключили насовсем.
        </p>

        <SwitchRow
          title="Занятый агент не получает новые лиды"
          on={shieldOn}
          onToggle={() => updateSettings.mutate({ agentOccupancyShieldEnabled: !shieldOn })}
          hint={
            shieldOn
              ? "Агент на показе по календарю или в живом звонке через CRM временно выпадает из раздачи — лид уйдёт следующему по очереди, а не будет ждать, пока он освободится."
              : "Раздача не смотрит на занятость: лид может прийти агенту прямо посреди показа или разговора."
          }
        />

        <form onSubmit={handleSaveOccupancy}>
          <NumberRow
            label="Показ или звонок считается активным ещё"
            unit="минут"
            min={1}
            max={240}
            value={shieldAfterMinutes}
            onChange={setShieldAfterMinutes}
            hint="Показ по календарю, который начался не позже этого срока назад и ещё не отмечен выполненным или отменённым, держит агента занятым. Живой звонок через CRM виден системе сразу, этот срок его не касается."
          />
          {/* Пул «ничьих» удалён целиком (17.09.2026, закон о владении клиентом
              П-4/Р-3) — «Автопередача при непозвонившем агенте» теперь передаёт
              лид сразу по истечении срока звонка, без промежуточного этапа. */}
          <SaveRow pending={updateSettings.isPending} saved={savedOccupancy} />
        </form>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Передача как признак конфликта</h2>
          <span className="note">Слова в комментарии к передаче, по которым CRM зовёт руководителя</span>
        </div>
        <p className="sub" style={{ marginBottom: "var(--s3)" }}>
          Причина передачи «Другое» требует комментария. Если в нём встретится любое из слов ниже (без учёта
          регистра, как часть любого слова), передача минует автоподбор агента и уходит прямо руководителю —
          с недовольным клиентом решает человек, не алгоритм. Список — первая прикидка мозгового штурма
          20–21.08.2026, ни разу не сверенная с реальными случаями: правьте по мере ложных срабатываний.
        </p>
        <KeywordTags values={conflictKeywords} onChange={setConflictKeywords} placeholder="слово" max={40} />
        <div className="quiet" style={{ marginTop: "var(--s3)" }}>
          <span className="dot" />
          <span className="txt">
            Пустой список осознанно выключает это распознавание — «Другое» тогда идёт обычной очередью по
            KPI, как остальные причины передачи.
          </span>
        </div>
        <div className="wrap" style={{ marginTop: "var(--s3)" }}>
          <button
            className="pill ghost"
            type="button"
            onClick={handleSaveConflictKeywords}
            disabled={updateSettings.isPending}
          >
            Сохранить
          </button>
          {savedConflictKeywords && <span className="saved on">Сохранено</span>}
        </div>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Лимит активных лидов</h2>
          <span className="note">Заполненный агент новых не получает</span>
        </div>
        <p className="sub" style={{ marginBottom: "var(--s3)" }}>
          Сейчас предел — <b>{limit === 0 ? "без лимита" : `${limit} активных лидов`}</b>. Само число правится
          {limitsTask ? <>в блоке <Link className="lnk" to="/settings?tab=leads&task=deadlines">«Сроки, лимиты и возврат»</Link>.</> : <>в «Деньгах».</>}
        </p>
        <p className="sub" style={{ marginBottom: "var(--s3)" }}>
          <b>Лид по своему объекту всегда уходит агенту объекта, без лимита</b> — решение владельца
          11.09.2026. Правило безусловное: ни лимит, ни занятый портфель его больше не останавливают.
          Ниже — что делать, когда у агента УЖЕ полный портфель обычных клиентов и он хочет освободить
          место под своего (это про момент принятия лида агентом, не про то, кому лид достаётся).
        </p>

        <SwitchRow
          title="Предлагать освободить место"
          on={releaseOn}
          onToggle={() => updateSettings.mutate(releaseToggleBody(releaseOn))}
          hint={
            releaseOn
              ? "Портфель полон, пришёл клиент по своему объекту — при нажатии «Принять» агенту предлагается отдать одного обычного клиента и взять этого. Отданный уходит другому агенту по очереди KPI. Отдать некого — клиент принимается сверх лимита."
              : "Предложения нет: агент принимает клиента по своему объекту сверх лимита, портфель не трогается. Клиент в общую очередь не уходит."
          }
        />

        {releaseOn && (
          <div className="mod">
            <div className="t">
              <b>Кого отдавать</b>
              <span>
                Освобождать можно только клиентов без единой попытки контакта — с кем уже был разговор,
                система сама не выбирает (закон владения П-4/П-6, 17.09.2026). Агент видит список и
                выбирает сам; режим «CRM выбирает случайно» убран.
              </span>
            </div>
          </div>
        )}

        {/* «Взвешенные слоты» — план владельца 20-21.08.2026, рубеж «слив»:
            «свежий 1.0, после показа 0.5, думает 0.25, гейминг становится
            бессмысленным, а не запрещённым». Живёт в этом же разделе: это то же
            самое место в лимите, только считается не штуками. */}
        <SwitchRow
          title="Взвешенные слоты"
          on={weightedSlotsOn}
          onToggle={() => updateSettings.mutate({ weightedLeadSlotsEnabled: !weightedSlotsOn })}
          hint={
            weightedSlotsOn
              ? "Место в лимите занимают по-разному: свежий клиент целиком, доведённый до показа — меньше, «думающий» — ещё меньше. Сливать почти доработанного клиента ради нового становится незачем."
              : "Все клиенты занимают по одному месту. Тогда, чтобы освободить место под новый лид, выгоднее всего слить того, с кем работа почти сделана."
          }
        />

        {weightedSlotsOn && (
          <form onSubmit={handleSaveSlotWeights}>
            <NumberRow
              label="Свежий клиент"
              unit="% места"
              min={0}
              max={1000}
              value={weightFresh}
              onChange={setWeightFresh}
              hint="Показа ещё не было. Сто процентов — одно полное место в лимите, как раньше у всех."
            />
            <NumberRow
              label="После показа"
              unit="% места"
              min={0}
              max={1000}
              value={weightAfterShowing}
              onChange={setWeightAfterShowing}
              hint="Хотя бы один показ уже состоялся: не отменён и либо отмечен выполненным, либо его время прошло."
            />
            <NumberRow
              label="Клиент думает"
              unit="% места"
              min={0}
              max={1000}
              value={weightThinking}
              onChange={setWeightThinking}
              hint="В «Итоге показа» выбрана ветка «клиент думает» и задача по ней ещё не закрыта. Эта ветка бывает только после показа и считается вместо него, а не вдобавок."
            />
            <p className="msg" style={{ color: "var(--faint)" }}>
              Считается только для покупателей: продавцы в лимит не входят вовсе. Число «столько-то из
              шести» на экранах остаётся штучным — веса меняют не показания, а решение о раздаче.
            </p>
            <SaveRow pending={updateSettings.isPending} saved={savedSlotWeights} />
          </form>
        )}
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Уведомления</h2>
          <span className="note">Что и как часто уходит агентам и руководству</span>
        </div>

        <div className="grp-lab">Уведомления о лидах</div>
        <SwitchRow
          title="Кнопки «Принять» и «Отклонить» прямо в уведомлении"
          on={pushActionsOn}
          onToggle={() => updateSettings.mutate({ pushLeadActionsEnabled: !pushActionsOn })}
          hint={
            pushActionsOn
              ? "Агент принимает лид, не открывая CRM. Работает на Android и в браузере на компьютере."
              : "Уведомление обычное: нажатие открывает карточку клиента, там и кнопки."
          }
          warning={
            pushActionsOn
              ? "На iPhone кнопок не будет: Safari их в уведомлениях не поддерживает. Там нажатие открывает карточку клиента с теми же кнопками — уведомление о лиде приходит в любом случае."
              : null
          }
        />

        <div className="grp-lab">Другие уведомления</div>
        <div className="quiet">
          <span className="dot" />
          <span className="txt">
            Здесь — общие правила для всей компании. Что присылать лично себе, каждый сотрудник выбирает сам
            в своём Профиле.
          </span>
        </div>

        <SwitchRow
          title="Просить клиента подтвердить показ"
          on={settings.askClientsToConfirmShowings}
          onToggle={() =>
            updateSettings.mutate({ askClientsToConfirmShowings: !settings.askClientsToConfirmShowings })
          }
          hint={
            settings.askClientsToConfirmShowings
              ? `${SHOWING_CONFIRM_ON_TEXT} Работает вместе с «Просить подтверждение встречи» во вкладке «Бот» — нужны оба.`
              : "Выключено 18.08.2026 — клиенту такие сообщения не приходят вовсе, даже на явно ошибочные времена показа."
          }
          warning={
            settings.askClientsToConfirmShowings && showingConfirmBlockedBy(settings, "leads") ? (
              <>
                {showingConfirmBlockedBy(settings, "leads")}{" "}
                <Link className="lnk" to="/settings?tab=bot">
                  Открыть «Бот»
                </Link>
              </>
            ) : null
          }
        />

        <SwitchRow
          title="Напоминания о показах ещё и руководству"
          on={settings.pushShowingsToSupervisors}
          onToggle={() =>
            updateSettings.mutate({ pushShowingsToSupervisors: !settings.pushShowingsToSupervisors })
          }
          hint={
            settings.pushShowingsToSupervisors
              ? "Руководитель видит те же напоминания о показах, что и агент: за день, за 2 часа и за 40 минут."
              : "Напоминания о показах приходят только агенту, который этот показ проводит."
          }
        />

        {/* «Сообщать агенту об изменении Royal Score» и «не чаще одного о счёте раз
            в N минут» убраны с экрана 23.09.2026: тумблер и число сохранялись, но
            уведомлений о счёте в коде нет вовсе — ни одна строка сервера это поле не читает (проверено поиском 23.09.2026).
            Поля pushOnScoreChange/pushScoreThrottleMinutes остаются в базе:
            вернуть строки, когда появится сама отправка. */}
        <form onSubmit={handleSaveNotify}>
          <NumberRow
            label="Не чаще одного о сообщениях клиента раз в"
            unit="минут"
            min={0}
            max={120}
            value={messageThrottle}
            onChange={setMessageThrottle}
            hint="Человек пишет пачкой: «здравствуйте», «а можно», «и ещё». 0 — уведомлять о каждом сообщении."
          />
          <SaveRow pending={updateSettings.isPending} saved={savedNotify} />
        </form>
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Когда агент уходит из компании</h2>
          <span className="note">Куда девать портфель</span>
        </div>
        <p className="sub" style={{ marginBottom: "var(--s3)" }}>
          Его портфель раздаётся оставшимся. Клиенты и объекты — по разным правилам нарочно: клиент это
          начатый разговор, объект — материал для работы.
        </p>

        <SwitchRow
          title="Клиентов сильным агентам"
          on={settings.handoverClientsToHighKpi}
          onToggle={() => updateSettings.mutate({ handoverClientsToHighKpi: !settings.handoverClientsToHighKpi })}
          hint={
            settings.handoverClientsToHighKpi
              ? "Клиенты уходят агентам с высоким KPI, горячие — первыми. Клиента нельзя ставить на паузу, пока новичок разбирается."
              : "Клиенты раздаются обычной очередью, наравне с новыми лидами."
          }
        />

        <SwitchRow
          title="Объекты тем, кому не с чем работать"
          on={settings.handoverPropertiesToLowKpi}
          onToggle={() =>
            updateSettings.mutate({
              handoverPropertiesToLowKpi: !settings.handoverPropertiesToLowKpi,
            })
          }
          hint={
            settings.handoverPropertiesToLowKpi
              ? "Объекты уходят агентам с низким KPI: это не горящий разговор, а материал, и он нужнее тому, у кого работы мало."
              : "Объекты раздаются обычной очередью, как и клиенты."
          }
        />
      </section>

      <section className="card">
        <div className="sec-h stack">
          <h2>Реактивация старых клиентов</h2>
          <span className="note">Раз в неделю бот сам пишет остывшим</span>
        </div>
        <p className="sub" style={{ marginBottom: "var(--s3)" }}>
          Пачка 12, 11.09.2026. Каждый понедельник в 10:00 по Душанбе бот сам пишет небольшой пачке клиентов
          в статусе «Остыл»/«Потерян» или Неактивных, с которыми давно не было касания, — короткое сообщение
          в их последний канал. Ответившие идут обычным путём обращения; агенту (или руководителю, если
          прежнего агента уже нет) ставится задача «перезвонить» на завтра.
        </p>

        <SwitchRow
          title="Еженедельная реактивация включена"
          on={reactivationOn}
          onToggle={() => updateSettings.mutate({ reactivationEnabled: !reactivationOn })}
          hint={
            reactivationOn
              ? "Каждый понедельник в 10:00 по Душанбе уходит очередная пачка сообщений — размер и срок ниже."
              : "Крон не собирает и не шлёт пачку — остывшие клиенты ждут обычной работы агентов."
          }
        />

        <form onSubmit={handleSaveReactivation}>
          <NumberRow
            label="Без касания дольше"
            unit="дней"
            min={1}
            max={720}
            value={reactivationAfterDays}
            onChange={setReactivationAfterDays}
            hint="Сколько дней должно пройти с последнего касания сотрудником (не входящего сообщения клиента), прежде чем карточка попадёт в очередь на реактивацию."
          />
          <NumberRow
            label="Размер пачки"
            unit="клиентов в неделю"
            min={1}
            max={200}
            value={reactivationBatchSize}
            onChange={setReactivationBatchSize}
            hint="Потолок карточек в одной недельной пачке — рассылка контролируемая, не залповая по всей базе остывших клиентов разом."
          />
          <div className="fld" style={{ marginTop: "var(--s4)" }}>
            <span className="lab">Шаблон сообщения</span>
            <textarea
              value={reactivationTemplate}
              onChange={(e) => setReactivationTemplate(e.target.value)}
              rows={3}
              aria-label="Шаблон сообщения реактивации"
            />
            <span className="msg">
              Плейсхолдеры <code>{"{name}"}</code> (имя клиента) и <code>{"{agent}"}</code> (кому досталась
              задача «перезвонить») подставляются перед отправкой — можно писать без них.
            </span>
          </div>
          <SaveRow pending={updateSettings.isPending} saved={savedReactivation} />
        </form>
      </section>
    </>
  );
}
