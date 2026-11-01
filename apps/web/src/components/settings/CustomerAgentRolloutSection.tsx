import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { customerAgentOwnerStateSchema, type CustomerAgentOwnerState, type CustomerAgentPublishRequest, type CustomerAgentRefreshRequest } from "@royal-home/shared";
import { api, ApiError } from "../../lib/api";
import { SettingsSection } from "./SettingsSection";
import { ConfirmDialog } from "../ConfirmDialog";
import { Switch } from "../Switch";

const key = ["settings", "customer-agent"] as const;
type Registration = { revisionId: string; activated: false };
type Publication = { policyRevision: string; rolloutMode: "ACTIVE"; existingPromotion: "not_implemented" };
type KillResult = { policyRevision: string; rolloutMode: "OFF" };
const capabilityLabels = {
  publicRead: "Читать карточки объектов",
  contactWrite: "Сохранять контакт клиента",
  callbackWrite: "Создавать подтверждённую заявку на звонок",
  newLeadBridge: "Создавать обращение в CRM",
  handoverWrite: "Передавать диалог сотруднику",
  showingWrite: "Управлять подтверждёнными показами",
  ownerQuestionWrite: "Передавать вопрос собственнику",
} satisfies Record<keyof CustomerAgentOwnerState["capabilities"], string>;

function message(error: unknown): string {
  if (!(error instanceof ApiError)) return error instanceof Error ? error.message : "Не удалось выполнить действие.";
  if (error.message === "recruitment_resume_upgrade_confirmation_required") return "Установлено обновление вопросов найма. Отметьте отдельное подтверждение обновления анкет кандидатов и повторите действие.";
  if (["recruitment_resume_upgrade_not_required", "recruitment_resume_upgrade_not_qualified"].includes(error.message)) return "Это подтверждение не подходит к установленной версии. Снимите отметку обновления анкет кандидатов и обновите состояние.";
  if (error.message === "quality_continuity_upgrade_confirmation_required") return "Для этой версии требуется отдельное подтверждение качества и продолжения диалога. Отметьте его и повторите действие.";
  if (["quality_continuity_upgrade_not_required", "quality_continuity_upgrade_not_qualified"].includes(error.message)) return "Подтверждение качества и продолжения не соответствует установленной версии. Обновите состояние и проверьте точную версию.";
  if (error.message === "quality_continuity_upgrade_configuration_changed") return "Это обновление допускается только без изменения модели, лимитов, доли, каналов и прав CRM.";
  if (error.status === 409) return "Настройки уже изменились или работа ещё занята. Обновите состояние и проверьте его перед новым действием.";
  if (error.status === 403) return "Право управления настройками отозвано. Обновите страницу.";
  if (error.status === 428) return "Нужно повторно подтвердить личность. После подтверждения проверьте состояние и нажмите действие ещё раз.";
  return error.message || "Сервер отклонил действие.";
}

/** Owner controls for the text customer agent. All writes are explicit and CAS-bound. */
export function CustomerAgentRolloutSection() {
  const cache = useQueryClient();
  const [reason, setReason] = useState("");
  const [percent, setPercent] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [paid, setPaid] = useState(false);
  const [noCap, setNoCap] = useState(false);
  const [advanceIdle, setAdvanceIdle] = useState(false);
  const [mediaUpgrade, setMediaUpgrade] = useState(false);
  const [catalogUpgrade, setCatalogUpgrade] = useState(false);
  const [recruitmentUpgrade, setRecruitmentUpgrade] = useState(false);
  const [qualityContinuityUpgrade, setQualityContinuityUpgrade] = useState(false);
  const [candidate, setCandidate] = useState<string | null>(null);
  const [capabilities, setCapabilities] = useState<CustomerAgentOwnerState["capabilities"]>({
    publicRead: false, contactWrite: false, callbackWrite: false, newLeadBridge: false,
    handoverWrite: false, showingWrite: false, ownerQuestionWrite: false,
  });
  const [confirm, setConfirm] = useState<"publish" | "kill" | "refresh" | null>(null);
  const state = useQuery({ queryKey: key, queryFn: async () => customerAgentOwnerStateSchema.parse(await api<unknown>("/settings/customer-agent")), retry: false });
  const refresh = () => cache.invalidateQueries({ queryKey: key });
  const register = useMutation({
    mutationFn: () => api<Registration>("/settings/customer-agent/revisions/register", { method: "POST", body: { configId: state.data!.configId, reason: reason.trim() } }),
    retry: false, onSuccess: async value => { setCandidate(value.revisionId); await refresh(); },
  });
  const publish = useMutation({
    mutationFn: (body: CustomerAgentPublishRequest) => api<Publication>("/settings/customer-agent/rollout", { method: "PUT", body }),
    retry: false, onSuccess: async () => { setConfirm(null); setCandidate(null); setPaid(false); setNoCap(false); setAdvanceIdle(false); setCatalogUpgrade(false); setRecruitmentUpgrade(false); setQualityContinuityUpgrade(false); await refresh(); },
  });
  const kill = useMutation({
    mutationFn: (body: { expectedPolicyRevision: string; reason: string }) => api<KillResult>("/settings/customer-agent/kill", { method: "POST", body }),
    retry: false, onSuccess: async () => { setConfirm(null); await refresh(); },
  });
  const adopt = useMutation({
    mutationFn: (body: CustomerAgentRefreshRequest) => api<{ policyRevision: string }>("/settings/customer-agent/refresh-current", { method: "POST", body }),
    retry: false, onSuccess: async () => { setConfirm(null); setCandidate(null); setRecruitmentUpgrade(false); setQualityContinuityUpgrade(false); await refresh(); },
  });
  const data = state.data;
  // Форма берёт значения с сервера только при смене опубликованной политики: фоновое обновление
  // (возврат на вкладку, новые счётчики диалогов) иначе стирало несохранённые галочки владельца.
  const policyRevision = data?.policyRevision;
  useEffect(() => {
    if (!data) return;
    setPercent(Math.floor((data.rollout?.percentBasisPoints ?? 0) / 100));
    setSelected(data.rollout?.allowed.map(scope => scope.endpointScopeId) ?? []);
    setCapabilities(data.capabilities);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- намеренно: только при смене политики
  }, [policyRevision]);
  const busy = register.isPending || publish.isPending || kill.isPending || adopt.isPending;
  const active = data?.rolloutMode === "ACTIVE";
  const chosenScopes = data?.scopes.filter(scope => selected.includes(scope.endpointScopeId)) ?? [];
  const changingRevision = !!candidate && !!data?.activeAgentRevisionId && candidate !== data.activeAgentRevisionId;
  const canPublish = !!data && !!(candidate || data.activeAgentRevisionId) && chosenScopes.length > 0 &&
    reason.trim().length > 0 && paid && noCap && (!changingRevision || advanceIdle) && !data.moreScopes && !busy;

  const publishMissing = !data || busy ? [] : [
    !reason.trim() && "причина изменения",
    chosenScopes.length === 0 && "хотя бы один аккаунт",
    !paid && "галочка «Платные обращения»",
    !noCap && "галочка «Дневной потолок расходов»",
    changingRevision && !advanceIdle && "галочка «Обновить версию нового бота»",
    data.moreScopes && "не все аккаунты загружены — обновите страницу",
  ].filter((item): item is string => !!item);

  function submitPublish() {
    if (!data) return;
    const candidateRevisionId = candidate ?? data.activeAgentRevisionId;
    if (!candidateRevisionId) return;
    publish.mutate({
      expectedPolicyRevision: data.policyRevision,
      rollout: { version: 1, cohortId: changingRevision ? crypto.randomUUID() : data.rollout?.cohortId ?? crypto.randomUUID(), candidateRevisionId,
        percentBasisPoints: percent * 100,
        allowed: chosenScopes.map(({ endpointScopeId, channel, surface }) => ({ endpointScopeId, channel, surface })) },
      capabilities,
      confirmManagedPaidCalls: true,
      acknowledgeNoDailyCap: true,
      ...(changingRevision ? { advanceIdleRevision: true as const } : {}),
      ...(changingRevision && mediaUpgrade ? { confirmMediaProfileUpgrade: true as const } : {}),
      ...(changingRevision && catalogUpgrade ? { confirmCatalogFactsUpgrade: true as const } : {}),
      ...(changingRevision && recruitmentUpgrade ? { confirmRecruitmentResumeUpgrade: true as const } : {}),
      ...(changingRevision && qualityContinuityUpgrade ? { confirmQualityContinuityUpgrade: true as const } : {}),
      reason: reason.trim(),
    });
  }
  function submitKill() {
    if (!data || !reason.trim()) return;
    kill.mutate({ expectedPolicyRevision: data.policyRevision, reason: reason.trim() });
  }
  function submitRefresh() {
    if (!data || !reason.trim()) return;
    adopt.mutate({ expectedPolicyRevision: data.policyRevision, reason: reason.trim(),
      ...(recruitmentUpgrade ? { confirmRecruitmentResumeUpgrade: true as const } : {}),
      ...(qualityContinuityUpgrade ? { confirmQualityContinuityUpgrade: true as const } : {}) });
  }

  return <SettingsSection icon={Bot} title="Текстовый агент клиентов" badge={active ? "активен" : "выключен"} defaultOpen>
    {state.isLoading && <p className="state">Загружаем состояние…</p>}
    {state.isError && <p className="state err" role="alert">{message(state.error)} <button type="button" className="lnk" onClick={() => void state.refetch()}>Обновить</button></p>}
    {data && <>
      <div className="mod"><div className="t"><b>{active ? "Включён" : "Выключен"}</b><span>Только новые подходящие диалоги получают назначение. Существующие назначения сохраняются.</span></div><div className="acts"><Switch on={active} disabled={busy} label="Текстовый агент включён" onToggle={() => setConfirm(active ? "kill" : "publish")} /></div></div>
      <p className="state">Диалог продолжает вести тот бот, с которым он начался. Эта настройка выбирает бота для новых диалогов.</p>
      {active && data.rollout && data.activeAgentRevisionId === data.rollout.candidateRevisionId && <div className="mod"><div className="t"><b>Обновить установленную версию</b><span>Сохраняет текущую долю {Math.floor(data.rollout.percentBasisPoints / 100)}%, каналы, права, модель и лимиты. Обычное обновление доступно без повторного кода после завершения текущих отправок; отдельное обновление качества требует действующего подтверждения администратора.</span></div><button type="button" className="pill" disabled={busy || !reason.trim()} onClick={() => setConfirm("refresh")}>Обновить версию бота</button></div>}
      {changingRevision && <label className="mod"><span className="t"><b>Обновить версию нового бота</b><span>После завершения текущих ходов новые сообщения уже подключённых к ядру диалогов получат исправленную версию. История, отправки и подтверждения сохранятся. Диалоги прежнего бота не переводятся.</span></span><input type="checkbox" checked={advanceIdle} onChange={event => setAdvanceIdle(event.target.checked)} /></label>}
      {changingRevision && data.configId === "royal-customer-g36-media-20261017-v3" && <label className="mod"><span className="t"><b>Подключить понимание фото, видео и голосовых</b><span>Gemini получит содержимое присланных файлов. Лимит расходов на ход, доля диалогов, каналы и права остаются прежними. Отдельное подтверждение нужно только при переходе с текстового профиля.</span></span><input type="checkbox" checked={mediaUpgrade} onChange={event => setMediaUpgrade(event.target.checked)} /></label>}
      {changingRevision && <label className="mod"><span className="t"><b>Обновить характеристики объектов и модерацию комментариев</b><span>Разрешить проверенную версию схемы публичных характеристик и обработки объявлений. Модель, расходы, доля диалогов, каналы и права не меняются.</span></span><input type="checkbox" checked={catalogUpgrade} onChange={event => setCatalogUpgrade(event.target.checked)} /></label>}
      {(active || changingRevision) && <label className="mod"><span className="t"><b>Обновить вопросы и анкеты кандидатов</b><span>Отдельно подтверждаю проверенную версию найма: вопросы по правилам выбранной вакансии и сохранение сведений с источниками. Решение о найме принимает человек. Процент диалогов, каналы, права, модель и лимиты сохраняются.</span></span><input type="checkbox" checked={recruitmentUpgrade} onChange={event => setRecruitmentUpgrade(event.target.checked)} /></label>}
      {(active || changingRevision) && <label className="mod"><span className="t"><b>Обновить качество и продолжение диалога</b><span>Отдельно подтверждаю проверенное обновление правил диалога и подготовки вложений. Реальная отправка вложений включается отдельно. Требуется действующее подтверждение администратора. Модель, расходы, доля, каналы, области, права CRM и лимиты остаются прежними.</span></span><input type="checkbox" checked={qualityContinuityUpgrade} onChange={event => setQualityContinuityUpgrade(event.target.checked)} /></label>}
      <p className="state">Текстовые личные сообщения и публичные комментарии используют текущие проверки отправки/модерации. Параллельное сравнение, голос, сайт, Telegram и YouTube здесь не включены.</p>
      <label className="fld"><span>Причина изменения</span><input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>
      {!candidate && <button type="button" className="pill ghost" disabled={busy || !reason.trim()} onClick={() => register.mutate()}>Подготовить нового бота</button>}
      {(candidate || data.activeAgentRevisionId) && <>
        <label className="fld"><span>Доля новых диалогов: {percent}%</span><input type="range" min={0} max={100} step={1} value={percent} onChange={event => setPercent(Number(event.target.value))} /></label>
        <fieldset className="wrap"><legend>Аккаунты</legend>
          {data.scopes.map(scope => <label className="mod" key={scope.endpointScopeId}><span className="t"><b>{scope.displayLabel}</b><span>{scope.channel} · {scope.surface === "dm" ? "личные сообщения" : "публичные комментарии"}</span></span><input type="checkbox" checked={selected.includes(scope.endpointScopeId)} onChange={event => setSelected(old => event.target.checked ? [...old, scope.endpointScopeId] : old.filter(id => id !== scope.endpointScopeId))} /></label>)}
          {data.moreScopes && <p className="state err">Сервер вернул неполный список областей; публикация закрыта до устранения этого ограничения.</p>}
        </fieldset>
        <fieldset className="wrap"><legend>Действия в CRM</legend>
          {(Object.keys(capabilityLabels) as Array<keyof typeof capabilityLabels>).map(name =>
            <label className="mod" key={name}><span className="t">{capabilityLabels[name]}</span>
              <input type="checkbox" checked={capabilities[name]} onChange={event =>
                setCapabilities(old => ({ ...old, [name]: event.target.checked }))} /></label>)}
        </fieldset>
        <label className="mod"><span className="t"><b>Платные обращения</b><span>Подтверждаю, что включение может создавать оплачиваемые обращения к модели.</span></span><input type="checkbox" checked={paid} onChange={event => setPaid(event.target.checked)} /></label>
        <label className="mod"><span className="t"><b>Дневной потолок расходов</b><span>Подтверждаю отсутствие настроенного дневного лимита.</span></span><input type="checkbox" checked={noCap} onChange={event => setNoCap(event.target.checked)} /></label>
        <button type="button" className="pill" disabled={!canPublish} onClick={() => setConfirm("publish")}>{active ? "Опубликовать изменения" : "Включить текстового агента"}</button>
        {publishMissing.length > 0 && <p className="state">Чтобы опубликовать, не хватает: {publishMissing.join(", ")}.</p>}
      </>}
      {data.counts.map(({ lane, count }) => <p className="state" key={lane}>{lane === "CORE" ? "Новый бот" : "Прежний бот"}: {count}</p>)}
    </>}
    {(register.isError || publish.isError || kill.isError || adopt.isError) && <p className="state err" role="alert">{message(register.error ?? publish.error ?? kill.error ?? adopt.error)}</p>}
    {confirm && <ConfirmDialog title={confirm === "kill" ? "Немедленно выключить агента?" : confirm === "refresh" ? "Обновить установленную версию бота?" : "Опубликовать настройки агента?"}
      description={confirm === "kill" ? "Новые отправки остановятся. Уже начатая отправка может завершиться; история и подтверждённые действия сохранятся." : confirm === "refresh" ? qualityContinuityUpgrade ? "Применится отдельно подтверждённое обновление качества и продолжения диалога после проверки незавершённой работы и действующего подтверждения администратора. Доля, каналы, области, права CRM, модель и лимиты расходов останутся прежними." : "Применится версия, уже установленная на сервере. Действующие процент, каналы, права и лимиты расходов останутся прежними. Изменения в форме настроек этим действием не применяются." : changingRevision ? "Будущие ходы нового бота получат исправленную версию только при отсутствии незавершённых отправок и действий. Доля выбирает новые диалоги. История и подтверждения сохраняются." : "Изменение применяется только к новым подходящим диалогам и может расходовать средства."}
      confirmLabel={confirm === "kill" ? "Выключить сейчас" : confirm === "refresh" ? "Обновить версию" : "Опубликовать"} dismissible={!busy}
      onCancel={() => setConfirm(null)} onConfirm={confirm === "kill" ? submitKill : confirm === "refresh" ? submitRefresh : submitPublish}
      confirmDisabled={busy || (confirm === "publish" && !canPublish) || !reason.trim()}
      confirmHint={!reason.trim() ? "Укажите причину изменения" : undefined}>
      {confirm === "kill" && <label className="fld"><span>Причина остановки</span>
        <input value={reason} maxLength={500} onChange={event => setReason(event.target.value)} /></label>}
    </ConfirmDialog>}
  </SettingsSection>;
}
