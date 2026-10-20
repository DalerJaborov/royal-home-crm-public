import { useMemo, useRef, useState } from "react";
import { useServerSyncedFields, useServerSyncedForm } from "../../hooks/useServerSyncedForm";
import { Link } from "react-router-dom";
import { Pencil, Plus, ShieldOff, Trash2, ShieldCheck, UserX, MoreHorizontal, X } from "lucide-react";
import { useAuthStore } from "../../store/auth";
import {
  useAgents,
  useCreateAgent,
  useUpdateAgent,
  useDeleteAgent,
  useFreeExtensions,
  useUploadAgentAvatar,
  useReset2fa,
} from "../../hooks/useAgents";
import { useSettings, useUpdateSettings } from "../../hooks/useSettings";
import { SwitchRow } from "../../components/Switch";
import { useCan } from "../../lib/permissions";
import { ROLE_LABELS } from "../../lib/roles";
import { EDITABLE_ROYAL_SCORE_EVENT_GROUPS, daysOffSentenceRu } from "@royal-home/shared";
import { DaysOffPicker } from "../../components/DaysOffPicker";
import { PhoneInput } from "../../components/FormField";
import { AgentPermissionsModal } from "../../components/AgentPermissionsModal";
import { ConfirmDialog } from "../../components/ConfirmDialog";

/**
 * Браузерной трубки (WebRTC) у сотрудников больше нет — удалена 18.08.2026 вместе
 * с рабочим местом оператора входящих (решение владельца). Отсюда ушли подпись
 * «◍ браузер: …», кнопка выдачи трубки и её окно: выдавать нечего, звонки идут
 * прямо агентам на мобильный, куда дозванивается станция. Признак «● внутренний
 * номер» остался — это регистрация НАСТОЯЩЕГО аппарата на АТС, другая сущность.
 *
 * Разметка — дословно эталон темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/settings-team.html): люди списком `.list`/`.row`
 * с аватаром `.av`, чипом KPI и круглыми кнопками `.pill.icon`; числа — строками `.mod`
 * с полем `.nf` внутри сетки `.fgrid`; формы — `.fld` с подписью `.lab`;
 * предупреждения — тихие строки `.quiet`, без карточек-уведомлений.
 */

/** Инициалы для кружка-аватара, когда фото не загружено. */
function initials(name: string) {
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase();
}

/** Вкладка «Сотрудники»: люди, их права и правила, по которым им достаются лиды. */

const DISTRIBUTION_STRATEGIES = [
  { value: "fair", label: "Честная очередь", hint: "наименее загруженному агенту (по умолчанию)" },
  { value: "round_robin", label: "По кругу", hint: "строго по очереди, без учёта нагрузки" },
  { value: "random", label: "Случайно", hint: "случайный активный агент" },
  { value: "manual", label: "Вручную", hint: "не назначает — ждёт руководителя" },
  { value: "kpi", label: "По KPI", hint: "сильные агенты первыми; порог 0 — получают все" },
] as const;

/** Числовая строка настройки: подпись, пояснение и поле `.nf` — строка `.mod` эталона. */
function NumberRow({
  label,
  hint,
  unit,
  value,
  min,
  max,
  step,
  onChange,
  wide = true,
  disabled = false,
}: {
  label: string;
  hint?: string;
  unit?: string;
  value: number | string;
  min: number;
  max: number;
  step?: number;
  onChange: (v: string) => void;
  wide?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className={`mod${wide ? " wide" : ""}`}>
      <div className="t">
        <b>{label}</b>
        {hint && <span>{hint}</span>}
      </div>
      <div className="acts">
        <span className="nf">
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            aria-label={label}
          />
          {unit && <span className="u">{unit}</span>}
        </span>
      </div>
    </div>
  );
}

/** Рабочие часы распределения лидов, ответ бота вне их, и алгоритм назначения агента.
 * Бот отвечает клиентам 24/7 (см. AiSection → "Бот отвечает клиентам") — здесь только
 * про то, когда новый лид уходит агенту, а не про доступность самого бота. */

export function AgentsSection() {
  const me = useAuthStore((s) => s.agent);
  const iAmDirector = me?.role === "DIRECTOR";
  const { data: agents, isLoading: agentsLoading, isError: agentsFailed, refetch: refetchAgents } = useAgents();
  const createAgent = useCreateAgent();
  const updateAgent = useUpdateAgent();
  const deleteAgent = useDeleteAgent();
  const uploadAvatar = useUploadAgentAvatar();
  const reset2fa = useReset2fa();
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ fullName: "", phone: "", role: "AGENT" });
  const [error, setError] = useState<string | null>(null);
  // Ошибка сброса 2FA — показывается над списком.
  const [twoFaError, setTwoFaError] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  /**
   * Отключение и сброс 2FA — через подтверждение (F6, 02.10.2026). Раньше оба
   * шли одним нажатием иконки: промах по соседней кнопке выкидывал сотрудника
   * из системы и необратимо снимал его с дежурств в настройках.
   */
  const [confirmRow, setConfirmRow] = useState<{ kind: "deactivate" | "reset2fa"; id: string; name: string } | null>(
    null
  );
  const [avatarUploadingId, setAvatarUploadingId] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);
  const avatarTargetId = useRef<string | null>(null);
  const [permissionsAgentId, setPermissionsAgentId] = useState<string | null>(null);
  // Кому сейчас заводим трубку в браузере. Пароль живёт только внутри этого окна.
  // Кому сейчас раскрыты действия строки: кнопки прячутся за «…», чтобы список
  // читался как на образце владельца, а не как панель управления (20.09.2026).
  const [actionsFor, setActionsFor] = useState<string | null>(null);
  // Инлайн-правка профиля сотрудника (ФИО/телефон/роль) — раньше данные агентов
  // после создания можно было менять только через БД, директор был бессилен.
  const [profileEditId, setProfileEditId] = useState<string | null>(null);
  // whisperLanguage: пустая строка — «как в агентстве» (в базе null); "off" — сотрудник
  // просил не играть ему подсказку о звонящем вовсе.
  const [profileForm, setProfileForm] = useState({
    fullName: "",
    phone: "",
    role: "AGENT",
    sipExtension: "",
    whisperLanguage: "",
    // Оператор первой линии: принимает звонки незнакомых номеров. Отдельно от
    // роли намеренно — это обязанность, её берут и отдают (владелец 20.09.2026).
    takesUnknownCalls: false,
    // Ник в Instagram, без @ (26.09.2026) — добавляется первым в соавторы Reels
    // при публикации объектов этого сотрудника (lib/instagramCollaborators.ts).
    instagramUsername: "",
    // «Присылать мои посты в Telegram» (28.09.2026) — true по умолчанию у нового
    // объекта формы, реальное значение подставляет startProfileEdit ниже.
    sharePostTelegram: true,
    // Личные выходные (владелец 11.10.2026): пусто — работает каждый день.
    weeklyDaysOff: [] as number[],
  });
  const [profileError, setProfileError] = useState<string | null>(null);
  // Предупреждение от сервера: номер сохранён, но АТС не ответила и проверить его
  // было нечем. Это не отказ — карточка закрывается, сообщение остаётся на виду.
  const [extensionNote, setExtensionNote] = useState<{ id: string; text: string } | null>(null);
  // Свободные номера с АТС спрашиваем только когда открыта форма: строку над списком
  // владелец убрал 20.09.2026 как лишний шум, и спрашивать станцию на каждое открытие
  // экрана больше незачем — подсказка нужна ровно у поля ввода номера.
  const freeExtensions = useFreeExtensions(profileEditId !== null || showForm);
  const can = useCan();
  type PeopleView = "active" | "frozen" | "off";
  const [view, setView] = useState<PeopleView>("active");
  const [query, setQuery] = useState("");
  const counts = useMemo(() => {
    const list = agents ?? [];
    return {
      total: list.length,
      active: list.filter((a) => a.isActive && !a.frozenAt).length,
      frozen: list.filter((a) => a.isActive && !!a.frozenAt).length,
      off: list.filter((a) => !a.isActive).length,
    };
  }, [agents]);
  const visibleAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (agents ?? []).filter((a) => {
      const inView =
        view === "active" ? a.isActive && !a.frozenAt : view === "frozen" ? a.isActive && !!a.frozenAt : !a.isActive;
      if (!inView) return false;
      if (!q) return true;
      return a.fullName.toLowerCase().includes(q) || a.phone.includes(q) || (a.sipExtension ?? "").includes(q);
    });
  }, [agents, view, query]);
  /**
   * ПРЕДУПРЕЖДЕНИЯ ЖИВУТ ВНУТРИ СТРОКИ СОТРУДНИКА (владелец 20.09.2026: «сделай так
   * чтобы этого не было и каждая строка была внутри своего агента, чтобы не мешать
   * интерфейсу и не путать нормальную сортировку»).
   *
   * Раньше те же тексты висели простынёй над списком: девять строк «не подключена
   * трубка» плюс восемь «принимает незнакомые звонки» занимали экран целиком, а
   * порядок людей в них не совпадал с порядком списка. Теперь каждая строка —
   * подпись под именем того, о ком она, и список сортируется как обычно.
   *
   * `=== false` / `=== true` намеренно: null значит «АТС не ответила, судить нельзя»,
   * и обвинять станцию в собственный обрыв связи не нужно.
   */
  function agentWarnings(a: {
    isActive: boolean;
    sipExtension?: string | null;
    takesUnknownCalls?: boolean;
    incomingQueueReady?: boolean | null;
    takesUnknownCallsUnexpected?: boolean | null;
  }): string[] {
    const out: string[] = [];
    /* Про «трубку» здесь не пишем ВООБЩЕ (владелец 20.09.2026: «не надо указывать
       трубка не подключена, и тем более я не знаю, что это значит — мы не собираемся
       подключать им трубку, все будут принимать через свой мобильный»). Настольных
       аппаратов у сотрудников нет, звонки доходят мобильным плечом, и отметка о
       регистрации аппарата на станции сообщала о поломке, которой не существует. */
    // Оператор назначен, но его номера нет в очереди станции — незнакомые звонки
    // мимо него. Сверка вернёт его туда сама, но до обхода это надо видеть.
    if (a.isActive && a.sipExtension && a.takesUnknownCalls && a.incomingQueueReady === false) {
      out.push(
        `Назначен оператором, но номер ${a.sipExtension} не числится в очереди на станции: незнакомые звонки до него не доходят. CRM вернёт его туда в ближайшие 15 минут.`
      );
    }
    // Обратная сторона: человек в очереди станции, а обязанности такой у него нет
    // («агенты никогда не должны принимать звонки вместо оператора»).
    if (a.takesUnknownCallsUnexpected === true) {
      out.push(
        "Принимает звонки незнакомых номеров, хотя оператором не назначен. CRM уберёт его из очереди в ближайшие 15 минут."
      );
    }
    return out;
  }

  function startProfileEdit(a: {
    id: string;
    fullName: string;
    phone: string;
    role: string;
    sipExtension?: string | null;
    whisperLanguage?: string | null;
    takesUnknownCalls?: boolean;
    instagramUsername?: string | null;
    sharePostTelegram?: boolean;
    weeklyDaysOff?: number[];
  }) {
    setProfileEditId(a.id);
    setProfileForm({
      fullName: a.fullName,
      phone: a.phone,
      role: a.role,
      sipExtension: a.sipExtension ?? "",
      whisperLanguage: a.whisperLanguage ?? "",
      takesUnknownCalls: a.takesUnknownCalls ?? false,
      instagramUsername: a.instagramUsername ?? "",
      sharePostTelegram: a.sharePostTelegram ?? true,
      weeklyDaysOff: a.weeklyDaysOff ?? [],
    });
    setProfileError(null);
    setExtensionNote(null);
  }

  async function handleSaveProfile(id: string) {
    setProfileError(null);
    setExtensionNote(null);
    try {
      // Пустая строка -> null, чтобы можно было очистить номер (undefined в JSON
      // не сериализуется и PATCH его просто не тронет — см. CLAUDE.md).
      const { sipExtension, whisperLanguage, instagramUsername, ...rest } = profileForm;
      const saved = await updateAgent.mutateAsync({
        id,
        body: {
          ...rest,
          sipExtension: sipExtension.trim() || null,
          // Пусто — «как в агентстве»: то же правило, что и у номера, null стирает
          // персональный выбор, а не выключает подсказку.
          whisperLanguage: whisperLanguage || null,
          // Пусто -> null — сотрудник не подключён к Instagram, соавтором не становится.
          instagramUsername: instagramUsername.trim() || null,
        },
      });
      setExtensionNote(saved?.extensionNote ? { id, text: saved.extensionNote } : null);
      setProfileEditId(null);
    } catch (err) {
      // Сюда попадают и отказы проверки номера (несуществующий, занятый коллегой) —
      // текст сервера уже написан для человека, показываем его как есть.
      setProfileError(err instanceof Error ? err.message : "Не удалось сохранить");
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await createAgent.mutateAsync(form);
      // «Номер выдан, но в очередь входящих не попал» сервер пишет именно в
      // ответе на заведение — раньше этот ответ выбрасывался, и директор узнавал
      // о проблеме, только когда новичку не доходили звонки (аудит 23.09.2026, №62).
      setExtensionNote(created?.extensionNote ? { id: created.id, text: created.extensionNote } : null);
      setForm({ fullName: "", phone: "", role: "AGENT" });
      setShowForm(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось создать агента");
    }
  }

  async function handleDelete(id: string) {
    setDeleteError(null);
    try {
      await deleteAgent.mutateAsync(id);
      setDeleteId(null);
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : "Не удалось удалить агента");
    }
  }

  function openAvatarPicker(id: string) {
    avatarTargetId.current = id;
    avatarInputRef.current?.click();
  }

  async function handleAvatarChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    const id = avatarTargetId.current;
    if (!file || !id) return;
    setAvatarUploadingId(id);
    setAvatarError(null);
    try {
      await uploadAvatar.mutateAsync({ id, file });
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Не удалось загрузить аватар");
    } finally {
      setAvatarUploadingId(null);
      if (avatarInputRef.current) avatarInputRef.current.value = "";
    }
  }

  return (
    <>
    <section className="card">
      <div className="sec-h stack">
        <h2>Люди</h2>
        <span className="note">Права раздаёт только директор</span>
      </div>

      {/* Крупные числа вместо строки-пересказа (владелец 20.09.2026: «всё должно быть
          стильно, минимализм и крупные тексты, чтобы быстро понять»). `.tile` — плитка
          темы, число в ней 28 px, на телефоне 23. */}
      <div className="tiles" style={{ gridTemplateColumns: "repeat(3,1fr)", marginBottom: "var(--s3)" }}>
        <div className="tile">
          <span className="hd">Всего</span>
          <b>{counts.total}</b>
        </div>
        <div className="tile">
          <span className="hd">Активные</span>
          <b>{counts.active}</b>
        </div>
        <div className="tile">
          <span className="hd">Отключённые</span>
          <b>{counts.off}</b>
        </div>
      </div>

      <div className="wrap" style={{ marginBottom: "var(--s3)" }}>
        <button className="pill ghost" type="button" onClick={() => setShowForm((v) => !v)}>
          <Plus className="i" aria-hidden="true" />
          {showForm ? "Свернуть форму" : "Добавить сотрудника"}
        </button>
        {iAmDirector && (
          <Link className="pill ghost" to="/settings/roles">
            Права по ролям
          </Link>
        )}
      </div>

      <div className="filters" style={{ marginBottom: 12 }}>
        <input
          className="inp"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Имя или номер"
          aria-label="Поиск по сотрудникам"
        />
        <div className="seg" role="tablist" aria-label="Кого показывать">
          {(
            [
              ["active", "Активные", counts.active],
              ["frozen", "Замороженные", counts.frozen],
              ["off", "Отключённые", counts.off],
            ] as const
          ).map(([key, label, n]) => (
            <button key={key} type="button" role="tab" aria-selected={view === key} onClick={() => setView(key)}>
              {label} <span className="n">{n}</span>
            </button>
          ))}
        </div>
      </div>

      {showForm && (
        <form onSubmit={handleCreate} className="fgrid" style={{ marginBottom: "var(--s4)" }}>
          <label className="fld">
            <span className="lab">Имя и фамилия</span>
            <input
              required
              placeholder="Например: Умед Каримов"
              value={form.fullName}
              onChange={(e) => setForm((f) => ({ ...f, fullName: e.target.value }))}
            />
          </label>
          <label className="fld">
            <span className="lab">Рабочий телефон</span>
            <PhoneInput
              required
              className=""
              placeholder="+992 __ ___ __ __"
              value={form.phone}
              onChange={(v) => setForm((f) => ({ ...f, phone: v }))}
            />
            <span className="msg">Он же логин при входе.</span>
          </label>
          <label className="fld">
            <span className="lab">Роль</span>
            <select value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}>
              <option value="AGENT">Агент</option>
              <option value="MARKETING">Маркетинг</option>
              <option value="EDITOR">Монтажёр</option>
              <option value="SECURITY">Служба безопасности</option>
              <option value="HEAD_OF_SALES">РОП — руководитель отдела продаж</option>
              <option value="SHAREHOLDER">Акционер (только просмотр)</option>
              <option value="MANAGER">Менеджер</option>
              <option value="ADMIN">Администратор</option>
              {iAmDirector && <option value="DIRECTOR">Директор</option>}
            </select>
            <span className="msg">Роль даёт набор прав по умолчанию. Дальше их можно поправить поштучно.</span>
          </label>
          {error && (
            <div className="quiet crit wide" role="alert">
              <span className="dot crit" />
              <span className="txt">{error}</span>
            </div>
          )}
          <div className="wrap wide">
            <button className="pill" type="submit" disabled={createAgent.isPending}>
              {createAgent.isPending ? "Создание..." : "Создать"}
            </button>
          </div>
        </form>
      )}
      <input ref={avatarInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={handleAvatarChange} />

      {permissionsAgentId && (
        <AgentPermissionsModal agentId={permissionsAgentId} onClose={() => setPermissionsAgentId(null)} />
      )}

      {twoFaError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{twoFaError}</span>
        </div>
      )}

      <div className="list">
        {/* Список сотрудников был заперт на `agents?.map` без isLoading/isError —
            при отказе раздел «Сотрудники» просто пустел, будто в агентстве никого
            нет. Это ровно тот дефект, с которого начинался раунд 1 в Team.tsx, и
            в настроечную копию того же списка его тогда не перенесли. */}
        {agentsLoading && (
          <div className="state">
            <span className="sk av" />
            <span className="sk w28" /> Загружаем сотрудников
          </div>
        )}
        {agentsFailed && (
          <div className="state err">
            <span className="dot crit" />
            Список не загрузился. Это сбой связи, а не пустая команда.{" "}
            <button
              className="lk"
              type="button"
              style={{ color: "inherit", textDecoration: "underline" }}
              onClick={() => refetchAgents()}
            >
              Повторить
            </button>
          </div>
        )}
        {agents && !agentsLoading && visibleAgents.length === 0 && (
          <div className="empty">
            <span className="ic">
              <svg className="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 21a8 8 0 0 1 16 0" />
              </svg>
            </span>
            <p>{query.trim() ? "Никого с таким именем или номером." : "В этом срезе никого нет."}</p>
          </div>
        )}
        {visibleAgents.map((a) => {
          // Учётку директора может менять только директор — скрываем действия у остальных.
          const locked = a.role === "DIRECTOR" && !iAmDirector;
          return (
            <div key={a.id} className={`row${a.isActive ? "" : " done"}`}>
              <button
                type="button"
                disabled={locked}
                onClick={() => openAvatarPicker(a.id)}
                title={locked ? undefined : "Изменить аватар"}
                aria-label={locked ? undefined : `Изменить аватар: ${a.fullName}`}
                className="av"
                style={{ border: 0, cursor: locked ? "default" : "pointer", overflow: "hidden" }}
              >
                {a.avatarUrl ? (
                  <img src={a.avatarUrl} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                ) : avatarUploadingId === a.id ? (
                  "…"
                ) : (
                  initials(a.fullName)
                )}
              </button>

              {profileEditId === a.id ? (
                <div className="t" style={{ flex: "1 1 100%" }}>
                  <div className="fgrid">
                    <label className="fld">
                      <span className="lab">ФИО</span>
                      <input
                        autoFocus
                        value={profileForm.fullName}
                        onChange={(e) => setProfileForm((f) => ({ ...f, fullName: e.target.value }))}
                        placeholder="ФИО"
                      />
                    </label>
                    <label className="fld">
                      <span className="lab">Телефон</span>
                      <PhoneInput
                        className=""
                        value={profileForm.phone}
                        onChange={(v) => setProfileForm((f) => ({ ...f, phone: v }))}
                        placeholder="Телефон"
                      />
                    </label>
                    <label className="fld">
                      <span className="lab">Роль</span>
                      <select
                        value={profileForm.role}
                        onChange={(e) => setProfileForm((f) => ({ ...f, role: e.target.value }))}
                        disabled={a.role === "DIRECTOR"}
                      >
                        <option value="AGENT">Агент</option>
                        <option value="MARKETING">Маркетинг</option>
                        <option value="EDITOR">Монтажёр</option>
                        <option value="SECURITY">Служба безопасности</option>
              <option value="HEAD_OF_SALES">РОП — руководитель отдела продаж</option>
              <option value="SHAREHOLDER">Акционер (только просмотр)</option>
                        <option value="MANAGER">Менеджер</option>
                        <option value="ADMIN">Администратор</option>
                        {a.role === "DIRECTOR" && <option value="DIRECTOR">Директор</option>}
                      </select>
                    </label>
                    <label className="fld">
                      <span className="lab">Внутренний номер на станции</span>
                      <input
                        value={profileForm.sipExtension}
                        onChange={(e) => setProfileForm((f) => ({ ...f, sipExtension: e.target.value }))}
                        placeholder="Например: 101"
                        title="Внутренний номер (SIP) на Asterisk, например 101"
                      />
                      {/* Какие номера реально свободны на станции. Без этой строки директор
                          вписывал номер по памяти, а об опечатке узнавал только тогда, когда
                          сотруднику переставали доходить звонки. */}
                      {freeExtensions.data &&
                        (freeExtensions.data.problem ? (
                          <span className="msg">
                            Список номеров с АТС недоступен ({freeExtensions.data.problem}) — номер сохранится без
                            проверки.
                          </span>
                        ) : freeExtensions.data.free.length ? (
                          <span className="msg">Свободные номера: {freeExtensions.data.free.join(", ")}</span>
                        ) : (
                          <span className="msg">Свободных номеров на АТС нет — их добавляет администратор станции.</span>
                        ))}
                    </label>
                    {/* Язык подсказки о звонящем — её слышит сам сотрудник перед
                        соединением (Настройки → Каналы связи). «Не играть» здесь не
                        прихоть: кому-то она мешает, и запрет должен быть личным. */}
                    <label className="fld">
                      <span className="lab">Подсказка о звонящем</span>
                      <select
                        value={profileForm.whisperLanguage}
                        onChange={(e) => setProfileForm((f) => ({ ...f, whisperLanguage: e.target.value }))}
                        title="На каком языке сотруднику звучит подсказка о звонящем"
                      >
                        <option value="">Как в агентстве</option>
                        <option value="tg">Таджикский</option>
                        <option value="ru">Русский</option>
                        <option value="off">Не играть</option>
                      </select>
                    </label>
                    {/* ОПЕРАТОР ПЕРВОЙ ЛИНИИ (владелец 20.09.2026: «незнакомый попадает
                        только в очередь на оператора, агент отвечает только своим
                        клиентам»). Признак решает состав очереди на станции: включили —
                        CRM допишет человека в очередь, выключили — уберёт оттуда. */}
                    <label className="fld">
                      <span className="lab">Принимает незнакомые звонки</span>
                      <select
                        value={profileForm.takesUnknownCalls ? "yes" : "no"}
                        onChange={(e) => setProfileForm((f) => ({ ...f, takesUnknownCalls: e.target.value === "yes" }))}
                        title="Оператор первой линии: звонки с номеров, которых нет в базе, идут ему"
                      >
                        <option value="no">Нет — только свои клиенты</option>
                        <option value="yes">Да — оператор первой линии</option>
                      </select>
                      <span className="msg">
                        {profileForm.takesUnknownCalls
                          ? "Звонки с незнакомых номеров идут в очередь операторов, и он в ней состоит."
                          : "Звонят только клиенты, закреплённые за ним."}
                      </span>
                    </label>
                    {/* Ник в Instagram (26.09.2026) — добавляется первым в соавторы Reels
                        при публикации объектов этого сотрудника, см. Настройки → Каналы. */}
                    <label className="fld">
                      <span className="lab">Ник в Instagram</span>
                      <input
                        value={profileForm.instagramUsername}
                        onChange={(e) => setProfileForm((f) => ({ ...f, instagramUsername: e.target.value }))}
                        placeholder="без @"
                        title="Ник в Instagram без @ — добавляется соавтором Reels по объектам этого сотрудника"
                      />
                    </label>
                    {/* «ПРИСЫЛАТЬ МОИ ПОСТЫ В TELEGRAM» (28.09.2026, lib/agentSharePost.ts) —
                        после публикации объекта ответственный агент получает готовый пост со
                        ссылками и кнопками «Поделиться»; личные профили дают больше охвата, чем
                        Страница. Общий рубильник — Настройки → Каналы связи; здесь — выключить
                        конкретному сотруднику. true по умолчанию, как и общий рубильник. */}
                    <label className="fld">
                      <span className="lab">Присылать мои посты в Telegram</span>
                      <select
                        value={profileForm.sharePostTelegram ? "yes" : "no"}
                        onChange={(e) => setProfileForm((f) => ({ ...f, sharePostTelegram: e.target.value === "yes" }))}
                        title="После публикации объекта присылать готовый пост со ссылками и кнопкой «Поделиться»"
                      >
                        <option value="yes">Да</option>
                        <option value="no">Нет</option>
                      </select>
                    </label>
                    {/* ЛИЧНЫЕ ВЫХОДНЫЕ (владелец 11.10.2026). Свои клиенты остаются за
                        сотрудником и в выходной: их сообщения и звонки доходят как обычно. */}
                    <div className="fld wide">
                      <span className="lab">Выходные дни</span>
                      <DaysOffPicker
                        label="Выходные дни сотрудника"
                        value={profileForm.weeklyDaysOff}
                        onChange={(next) => setProfileForm((f) => ({ ...f, weeklyDaysOff: next }))}
                      />
                      <span className="msg">
                        {profileForm.weeklyDaysOff.length
                          ? `Сейчас: ${daysOffSentenceRu(profileForm.weeklyDaysOff)}. В эти дни новые заявки уходят коллегам, штрафы и счётчики тишины не идут, робот не назначает на эти дни показы. Свои клиенты остаются за ним, их сообщения и звонки доходят как обычно.`
                          : "Выходных нет — работает каждый день. Отметьте дни, в которые сотрудник не получает новые заявки."}
                      </span>
                    </div>
                    <div className="wrap wide">
                      <button
                        className="pill"
                        type="button"
                        onClick={() => handleSaveProfile(a.id)}
                        disabled={updateAgent.isPending || profileForm.fullName.trim().length < 2}
                      >
                        {updateAgent.isPending ? "Сохраняем…" : "Сохранить"}
                      </button>
                      <button className="pill ghost" type="button" onClick={() => setProfileEditId(null)}>
                        Отмена
                      </button>
                    </div>
                    {profileError && (
                      <div className="quiet crit wide" role="alert">
                        <span className="dot crit" />
                        <span className="txt">{profileError}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="t">
                  <b>
                    {a.fullName}
                    {!locked && (
                      <button
                        className="lk"
                        type="button"
                        onClick={() => startProfileEdit(a)}
                        title="Изменить ФИО, телефон, роль"
                        aria-label={`Изменить данные: ${a.fullName}`}
                        style={{ marginLeft: 6 }}
                      >
                        <Pencil className="i" aria-hidden="true" />
                      </button>
                    )}
                  </b>
                  {/* Строка «номер · роль · внутренний · деактивирован» переносится:
                      обрезать её нельзя — «деактивирован» стоит в самом конце, и это
                      единственный признак отключённого сотрудника в списке. */}
                  {/* Роль и телефон — всё, что нужно в строке (владелец 20.09.2026).
                      Внутренний номер станции и его состояние отсюда убраны: они
                      ничего не говорят тому, кто не занимается телефонией, а править
                      номер всё равно можно только в форме ниже. Состояние —
                      отдельным чипом справа, как на образце владельца. */}
                  <span style={{ whiteSpace: "normal" }}>
                    {ROLE_LABELS[a.role]} · {a.phone}
                  </span>
                  {/* Номер сохранён, но АТС была недоступна — проверить его было нечем.
                      Это предупреждение, а не ошибка: сохранение мы не блокируем. */}
                  {extensionNote?.id === a.id && (
                    <span className="msg" style={{ color: "var(--warn)", whiteSpace: "normal" }}>
                      {extensionNote.text}
                    </span>
                  )}
                  {/* Предупреждения по этому сотруднику — здесь, а не простынёй над
                      списком (владелец 20.09.2026). Кнопка «Открыть» не нужна:
                      карандаш правки стоит рядом с именем. */}
                  {agentWarnings(a).map((text) => (
                    <span key={text} className="msg" style={{ color: "var(--warn)", whiteSpace: "normal" }}>
                      {text}
                    </span>
                  ))}
                </div>
              )}

              {/* Состояние сотрудника одним чипом — как на образце владельца.
                  KPI и счётчик клиентов отсюда убраны 20.09.2026 по его просьбе:
                  это экран настроек, а не отчёт, и цифры мешали читать список. */}
              <span className={`chip ${!a.isActive ? "crit" : a.frozenAt ? "warn" : "ok"}`}>
                {!a.isActive ? "Отключён" : a.frozenAt ? "Заморожен" : "Активен"}
              </span>

              {locked ? (
                <span className="meta">только директор</span>
              ) : deleteId === a.id ? (
                <div className="act">
                  <span className="chip crit">Удалить?</span>
                  <button
                    className="pill sm"
                    type="button"
                    onClick={() => handleDelete(a.id)}
                    disabled={deleteAgent.isPending}
                  >
                    Да
                  </button>
                  <button className="pill ghost sm" type="button" onClick={() => setDeleteId(null)}>
                    Отмена
                  </button>
                </div>
              ) : actionsFor !== a.id ? (
                /* Одна кнопка «…» вместо пяти (владелец 20.09.2026: «убрать лишние
                   штучки, должны быть визуально красивые и понятные настройки»).
                   Действия те же, просто раскрываются по нажатию — строка при этом
                   читается как имя, роль, телефон и состояние, и ничего больше. */
                <div className="act">
                  <button
                    className="pill ghost sm icon"
                    type="button"
                    onClick={() => setActionsFor(a.id)}
                    title="Действия"
                    aria-label={`Действия: ${a.fullName}`}
                  >
                    <MoreHorizontal className="i" aria-hidden="true" />
                  </button>
                </div>
              ) : (
                // Кнопки строки — круглые `.pill.icon` (договор дизайна: «строка
                // 56 px: аватар 36, текст, чип, круглая кнопка»).
                <div className="act">
                  {/* Права раздаёт тот, у кого есть permissions.manage (директор и, с
                      14.09.2026, админ по умолчанию — обычная ASSIGNABLE-галочка, не
                      владельческая) — у остальных кнопки нет, и сервер всё равно откажет. */}
                  {can("permissions.manage") && a.role !== "DIRECTOR" && (
                    <button
                      className="pill ghost sm icon"
                      type="button"
                      onClick={() => setPermissionsAgentId(a.id)}
                      title="Права доступа"
                      aria-label={`Права доступа: ${a.fullName}`}
                    >
                      <ShieldCheck className="i" aria-hidden="true" />
                    </button>
                  )}
                  {can("agents.reset2fa") && (
                    <button
                      className="pill ghost sm icon"
                      type="button"
                      onClick={() => setConfirmRow({ kind: "reset2fa", id: a.id, name: a.fullName })}
                      title="Сбросить 2FA (сотрудник потерял телефон): вход снова только по коду из СМС"
                      aria-label={`Сбросить 2FA: ${a.fullName}`}
                    >
                      <ShieldOff className="i" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    className="pill ghost sm icon"
                    type="button"
                    onClick={() =>
                      a.isActive
                        ? setConfirmRow({ kind: "deactivate", id: a.id, name: a.fullName })
                        : updateAgent.mutate({ id: a.id, body: { isActive: true } })
                    }
                    title={a.isActive ? "Деактивировать" : "Активировать"}
                    aria-label={`${a.isActive ? "Деактивировать" : "Активировать"}: ${a.fullName}`}
                  >
                    <UserX className="i" aria-hidden="true" />
                  </button>
                  <button
                    className="pill ghost sm icon"
                    type="button"
                    onClick={() => {
                      setDeleteError(null);
                      setDeleteId(a.id);
                    }}
                    title="Удалить"
                    aria-label={`Удалить: ${a.fullName}`}
                  >
                    <Trash2 className="i" aria-hidden="true" />
                  </button>
                  <button
                    className="pill ghost sm icon"
                    type="button"
                    onClick={() => setActionsFor(null)}
                    title="Свернуть действия"
                    aria-label={`Свернуть действия: ${a.fullName}`}
                  >
                    <X className="i" aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {deleteError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{deleteError}</span>
        </div>
      )}
      {avatarError && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{avatarError}</span>
        </div>
      )}

      {confirmRow?.kind === "deactivate" && (
        <ConfirmDialog
          title={`Отключить ${confirmRow.name}?`}
          description="Сотрудник выйдет из всех сеансов и перестанет получать уведомления. Непринятые лиды вернутся в общую очередь. Его снимут с дежурств в настройках — после включения их придётся назначить заново. Клиенты в работе останутся за ним."
          confirmLabel={updateAgent.isPending ? "Отключаем…" : "Отключить"}
          confirmDisabled={updateAgent.isPending}
          onCancel={() => setConfirmRow(null)}
          onConfirm={() =>
            updateAgent.mutate(
              { id: confirmRow.id, body: { isActive: false } },
              { onSettled: () => setConfirmRow(null) }
            )
          }
        />
      )}
      {confirmRow?.kind === "reset2fa" && (
        <ConfirmDialog
          title={`Сбросить вторую проверку у ${confirmRow.name}?`}
          description="Вход снова будет только по коду из СМС, пока сотрудник заново не подключит проверку на телефоне. Делайте это, только если он потерял телефон."
          confirmLabel={reset2fa.isPending ? "Сбрасываем…" : "Сбросить"}
          confirmDisabled={reset2fa.isPending}
          onCancel={() => setConfirmRow(null)}
          onConfirm={async () => {
            const id = confirmRow.id;
            try {
              await reset2fa.mutateAsync(id);
              setTwoFaError(null);
            } catch (err) {
              setTwoFaError(err instanceof Error ? err.message : "Не удалось сбросить 2FA");
            } finally {
              setConfirmRow(null);
            }
          }}
        />
      )}

    </section>
    </>
  );
}

/**
 * Веса показателей Royal Score / KPI (решение владельца 01.08.2026: ни одно
 * число не живёт в коде — директор правит без программиста).
 *
 * Подписи человеческие, а не ключи из кода. Вес 0 выключает показатель целиком.
 * Сумма показывается живьём: перекошенные веса делают рейтинг необъяснимым, а
 * объяснимость — обязательное требование спецификации.
 */
const KPI_WEIGHT_LABELS: { key: string; label: string; hint: string }[] = [
  { key: "response", label: "Скорость ответа", hint: "как быстро агент связался с новым лидом" },
  { key: "crm", label: "Работа с CRM", hint: "задачи дня закрыты вовремя" },
  { key: "discipline", label: "Дисциплина", hint: "нет просроченных хвостов" },
  { key: "contract", label: "Договоры", hint: "сделка закрыта и оформлена правильно" },
  { key: "photo", label: "Фотографии", hint: "у опубликованных объектов не меньше 15 снимков" },
  { key: "video", label: "Видео", hint: "у опубликованных объектов есть ссылка на обзор" },
  { key: "personalLeads", label: "Личные лиды", hint: "клиент, которого агент привёл сам" },
  { key: "cards", label: "Карточки", hint: "карточки принятых клиентов заполнены" },
];

/**
 * Настоящий рубильник модуля Royal Score целиком (решение владельца 15.09.2026).
 *
 * До этого владелец пытался остановить модуль обнулением весов KPI и отключением
 * пушей — но начисления, журнал и карточка в профиле продолжали работать: ни то,
 * ни другое не было выключателем, только настройками того, что уже включено.
 *
 * Выключен — recordScoreEvent (lib/scoreJournal.ts) не пишет ни одной новой строки
 * в журнал, push о счёте не уходит, кабинет агента и карточка в профиле не
 * показываются. Уже накопленный журнал никуда не девается — включили обратно, и
 * счёт продолжает считаться с того же места.
 */
export function RoyalScoreToggleSection() {
  const { data: settings } = useSettings();
  const save = useUpdateSettings();
  const on = settings?.royalScoreEnabled ?? true;

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Royal Score — рубильник модуля</h2>
        <span className="note">Выключает начисления, уведомления и кабинет агента целиком</span>
      </div>
      <SwitchRow
        title="Модуль Royal Score включён"
        on={on}
        hint={
          on
            ? "Начисления пишутся в журнал, уведомления уходят, агент видит счёт в профиле."
            : "Новые события не записываются, уведомления о счёте не уходят, кабинет и карточка в профиле у агентов не показываются. Уже накопленный журнал сохранён — включите обратно, и счёт продолжит считаться с того же места."
        }
        onToggle={() => save.mutate({ royalScoreEnabled: !on })}
      />
    </section>
  );
}

export function KpiWeightsSection() {
  const { data: settings } = useSettings();
  const royalScoreOn = settings?.royalScoreEnabled ?? true;
  // silent: своя «Сохранено — действует со следующего пересчёта» и текст ошибки ниже.
  const updateSettings = useUpdateSettings({ silent: true });
  const [weights, setWeights] = useState<Record<string, number>>({});
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const kpiFromServer = settings?.kpiWeights as Record<string, number> | undefined;
  useServerSyncedForm(
    settings &&
      Object.fromEntries(
        KPI_WEIGHT_LABELS.map(({ key }) => [key, kpiFromServer?.[key] ?? DEFAULT_WEIGHTS[key] ?? 0])
      ),
    weights,
    (patch) => setWeights((w) => ({ ...w, ...patch }) as Record<string, number>)
  );

  const total = Object.values(weights).reduce((s, v) => s + (Number.isFinite(v) ? v : 0), 0);

  async function save() {
    /* Веса заполняются только внутри `if (settings)`. При неотвеченном запросе
       объект пуст, шапка честно печатает «Сумма: 0», а сохранение записало бы
       нули во ВСЕ показатели — а нулевой вес, по тексту самой секции, ВЫКЛЮЧАЕТ
       показатель совсем (аудит 22.08.2026, раунд 6). */
    if (!settings) {
      setError("Настройки ещё не загрузились — веса на экране не настоящие, сохранять нельзя");
      return;
    }
    setError(null);
    setSaved(false);
    try {
      await updateSettings.mutateAsync({ kpiWeights: weights });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить веса");
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Из чего складывается KPI</h2>
        <span className="note">Сумма 100. Вес 0 выключает показатель совсем</span>
      </div>

      <div className="quiet">
        <span className={total === 100 ? "dot ok" : "dot warn"} />
        <span className="txt">
          Сумма сейчас: {total}. Итог нормируется к 100 при любой сумме, но круглые веса легче объяснять агенту.
          Показатель, недоступный агенту в конкретный день (не было публикаций, сделок), из расчёта этого дня
          исключается сам.
        </span>
      </div>

      <div className="fgrid">
        {KPI_WEIGHT_LABELS.map(({ key, label, hint }) => (
          <NumberRow
            key={key}
            label={label}
            hint={hint}
            unit="из 100"
            min={0}
            max={100}
            value={weights[key] ?? 0}
            disabled={!royalScoreOn}
            onChange={(v) => setWeights((w) => ({ ...w, [key]: Math.max(0, Math.min(100, Number(v) || 0)) }))}
          />
        ))}
      </div>

      {!royalScoreOn && (
        <div className="quiet">
          <span className="dot warn" />
          <span className="txt">Модуль Royal Score выключен — веса ни на что сейчас не влияют.</span>
        </div>
      )}

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}

      <div className="wrap" style={{ marginTop: "var(--s4)" }}>
        <button
          className="pill ghost"
          type="button"
          onClick={save}
          disabled={updateSettings.isPending || !settings || !royalScoreOn}
        >
          {updateSettings.isPending ? "Сохраняем…" : "Сохранить веса"}
        </button>
        {saved && <span className="saved on">Сохранено, действует со следующего пересчёта</span>}
      </div>
    </section>
  );
}

/** Зашитые значения — совпадают с DEFAULT_KPI_WEIGHTS на сервере. Дублируются
 *  сознательно: тянуть их отдельным запросом ради подстановки в пустую форму
 *  не стоит, а разъедутся — сервер всё равно источник истины. */
const DEFAULT_WEIGHTS: Record<string, number> = {
  response: 20, crm: 20, discipline: 20, photo: 10, video: 10, contract: 20, personalLeads: 10, cards: 10,
};

/**
 * Цена каждого события Royal Score (решение владельца 03.08.2026: «настройки,
 * чтобы я менял всё, что хочу, и чтобы не было никакого риска»). Значения по
 * умолчанию дублируют DEFAULT_EVENT_POINTS сервера — источник истины всё равно
 * сервер, дубликат только для пустой формы до первой загрузки.
 *
 * kpi_override и lead_missed сюда не включены: это устаревшие виды событий,
 * оставленные только для чтения старых записей журнала — их цена ничего
 * больше не начисляет (см. scoreJournal.ts).
 */
/**
 * Каталог событий Royal Score — ОДИН на сервер и на этот экран:
 * `@royal-home/shared`, royalScoreEvents.ts. Здесь была вторая копия (ключ,
 * подпись, цена по умолчанию), и она разошлась с серверной: `lead_ignored`
 * (12.08.2026) и `client_recovered_bonus` (01.09.2026) начислялись на проде,
 * но на экран не попали. Это не только «не видно»: форма отправляет
 * `royalScoreEventPoints` ЦЕЛИКОМ своим набором ключей, а сервер пишет
 * присланное поверх прежнего — значит каждое сохранение стирало этим двум
 * событиям ранее заданную цену.
 */

export function RoyalScoreEventsSection() {
  const { data: settings } = useSettings();
  const royalScoreOn = settings?.royalScoreEnabled ?? true;
  // silent: своя «Сохранено — действует со следующего пересчёта» и текст ошибки ниже.
  const updateSettings = useUpdateSettings({ silent: true });
  const [points, setPoints] = useState<Record<string, number>>({});
  const [windowDays, setWindowDays] = useState(30);
  const [startingScore, setStartingScore] = useState(100);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pointsFromServer = settings?.royalScoreEventPoints as Record<string, number> | undefined;
  useServerSyncedForm(
    settings &&
      Object.fromEntries(
        EDITABLE_ROYAL_SCORE_EVENT_GROUPS.flatMap((g) => g.events).map(({ key, points }) => [
          key,
          pointsFromServer?.[key] ?? points,
        ])
      ),
    points,
    (patch) => setPoints((p) => ({ ...p, ...patch }) as Record<string, number>)
  );
  useServerSyncedFields(
    settings && {
      windowDays: settings.royalScoreWindowDays ?? 30,
      startingScore: settings.royalScoreStartingScore ?? 100,
    },
    {
      windowDays: [windowDays, setWindowDays],
      startingScore: [startingScore, setStartingScore],
    }
  );

  async function save() {
    // Форма ещё заполняется значениями по умолчанию: настройки не пришли, и
    // сохранение стёрло бы настроенные цены событий пустым набором (WEB-PAGES22).
    if (!settings) return;
    setError(null);
    setSaved(false);
    try {
      await updateSettings.mutateAsync({
        royalScoreEventPoints: points,
        royalScoreWindowDays: windowDays,
        royalScoreStartingScore: startingScore,
      });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось сохранить настройки Royal Score");
    }
  }

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Royal Score</h2>
        <span className="note">Цена каждого события в баллах</span>
      </div>

      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Счёт агента — стартовое значение плюс сумма событий за скользящее окно, от 0 до 100. Цену события можно
          поставить и отрицательной (штраф), и положительной (начисление); ноль — событие фиксируется в журнале, но на
          счёт не влияет.
        </span>
      </div>

      <div className="fgrid">
        <NumberRow
          label="Окно расчёта"
          unit="дней"
          min={1}
          max={365}
          value={windowDays}
          disabled={!royalScoreOn}
          onChange={(v) => setWindowDays(Math.max(1, Math.min(365, Number(v) || 1)))}
          wide={false}
        />
        <NumberRow
          label="Стартовый счёт нового агента"
          unit="баллов"
          min={0}
          max={100}
          value={startingScore}
          disabled={!royalScoreOn}
          onChange={(v) => setStartingScore(Math.max(0, Math.min(100, Number(v) || 0)))}
          wide={false}
        />
      </div>

      {!royalScoreOn && (
        <div className="quiet">
          <span className="dot warn" />
          <span className="txt">Модуль Royal Score выключен — эти значения ни на что сейчас не влияют.</span>
        </div>
      )}

      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          Это НЕ «обнуление раз в N дней»: окно скользящее, пересчитывается каждый день, и старые события выпадают из
          него по одному, а не все разом. Агент, который улучшил работу сегодня, увидит эффект в счёте сразу, не
          дожидаясь конца периода.
        </span>
      </div>

      {EDITABLE_ROYAL_SCORE_EVENT_GROUPS.map((group) => (
        <div key={group.title}>
          <div className="grp-lab">{group.title}</div>
          <div className="fgrid">
            {group.events.map(({ key, label }) => (
              <NumberRow
                key={key}
                label={label}
                unit="баллов"
                min={-100}
                max={100}
                step={0.1}
                value={points[key] ?? 0}
                disabled={!royalScoreOn}
                onChange={(v) => setPoints((p) => ({ ...p, [key]: Math.max(-100, Math.min(100, Number(v) || 0)) }))}
              />
            ))}
          </div>
        </div>
      ))}

      {error && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">{error}</span>
        </div>
      )}

      <div className="wrap" style={{ marginTop: "var(--s4)" }}>
        <button className="pill ghost" type="button" onClick={save} disabled={updateSettings.isPending || !settings || !royalScoreOn}>
          {updateSettings.isPending ? "Сохраняем…" : "Сохранить"}
        </button>
        {saved && <span className="saved on">Сохранено, действует со следующего пересчёта</span>}
      </div>
    </section>
  );
}

/**
 * ВЫХОДНЫЕ КОМПАНИИ (владелец 11.10.2026: «у нас нет никаких выходных — робот и телефон
 * всегда в сети; агенты тоже работают каждый день»). По умолчанию все дни рабочие;
 * отмеченный день сохраняется сразу, как алгоритм раздачи выше.
 */
function CompanyDaysOffBlock() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const days = settings?.companyDaysOff ?? [];
  return (
    <div className="mod">
      <div className="t">
        <b>Выходные компании</b>
        <span>
          По умолчанию выходных нет: робот, телефон и агенты работают каждый день. Отмеченный день — общий выходной:
          в этот день не начисляются штрафы и не идут счётчики тишины, робот не обещает звонок агента и не назначает
          показы, а бот называет клиенту выходные. Личный выходной сотрудника задаётся при правке сотрудника.
        </span>
        <span>{`Сейчас: ${daysOffSentenceRu(days)}.`}</span>
      </div>
      <div className="acts">
        <DaysOffPicker
          label="Выходные компании"
          value={days}
          disabled={updateSettings.isPending || !settings}
          onChange={(next) => updateSettings.mutate({ companyDaysOff: next })}
        />
      </div>
    </div>
  );
}

export function LeadDistributionSection() {
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  // silent: форма часов ниже сама пишет «Сохранено» — кнопки алгоритма выше остаются
  // на общем тосте, у них нет своего текста, только подсветка выбранной по данным с сервера.
  const updateForm = useUpdateSettings({ silent: true });
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [kpiThreshold, setKpiThreshold] = useState("");
  const [saved, setSaved] = useState(false);

  useServerSyncedFields(
    settings && {
      start: settings.workHoursStart,
      end: settings.workHoursEnd,
      kpiThreshold: String(settings.kpiMinThreshold),
    },
    {
      start: [start, setStart],
      end: [end, setEnd],
      kpiThreshold: [kpiThreshold, setKpiThreshold],
    }
  );

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaved(false);
    await updateForm.mutateAsync({
      workHoursStart: start,
      workHoursEnd: end,
      kpiMinThreshold: Number(kpiThreshold),
    });
    setSaved(true);
  }

  const strategy = settings?.leadDistributionStrategy ?? "fair";
  const current = DISTRIBUTION_STRATEGIES.find((s) => s.value === strategy);

  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>Распределение лидов</h2>
        <span className="note">
          Как выбирается агент для нового лида: сайт, Instagram/WhatsApp-бот, Telegram
        </span>
      </div>

      <div className="seg" role="group" aria-label="Алгоритм назначения агента">
        {DISTRIBUTION_STRATEGIES.map((s) => (
          <button
            key={s.value}
            type="button"
            title={s.hint}
            aria-selected={strategy === s.value}
            disabled={updateSettings.isPending}
            onClick={() => updateSettings.mutate({ leadDistributionStrategy: s.value })}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="quiet">
        <span className="dot" />
        <span className="txt">
          {current ? `${current.label}: ${current.hint}.` : "Алгоритм не выбран."}
        </span>
      </div>

      {strategy === "kpi" && (
        <>
          <div className="mod">
            <div className="t">
              <b>Минимальный KPI для допуска к распределению</b>
              <span>KPI считается автоматически каждую ночь; поправить вручную можно в списке сотрудников выше.</span>
            </div>
            <div className="acts">
              <span className="nf">
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={kpiThreshold}
                  onChange={(e) => setKpiThreshold(e.target.value)}
                  aria-label="Минимальный KPI для допуска к распределению"
                />
                <span className="u">из 100</span>
              </span>
            </div>
          </div>
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              {Number(kpiThreshold) > 0
                ? "Агенты с KPI ниже порога временно не получают новых лидов. Поставьте 0, чтобы лиды доходили до всех."
                : "0 — отсева нет: лиды получают все агенты. Сильные первыми, слабые позже, когда у сильных наберётся предел активных лидов. Даже агент с низким KPI дождётся своей очереди."}
            </span>
          </div>
        </>
      )}

      <form onSubmit={handleSave}>
        <div className="mod">
          <div className="t">
            <b>Когда лиды уходят агентам</b>
            <span>
              Бот работает круглосуточно и без ограничений: отвечает, читает фото и голосовые, принимает заявки в любое
              время суток. Главное, что задают эти часы: когда готовая заявка попадает агенту. Принятая ночью дожидается
              начала рабочего дня и назначается автоматически, чтобы время ответа не шло, пока агент спит.
            </span>
            <span>
              Эти же часы — «рабочий день» и для телефона: вне их консультант (Бот → Живой голос) берёт трубку сразу, не
              дожидаясь оператора, и не соединяет звонящего с агентом, а обещает перезвон утром. По ним же бот в
              переписке обещает звонок «сейчас» или «в рабочее время», обратный звонок оператору не заказывается ночью, а
              тревога «клиент написал, агент не ответил» считает от них начало дня.
            </span>
          </div>
          <div className="acts">
            <span className="nf">
              <input
                type="time"
                value={start}
                onChange={(e) => setStart(e.target.value)}
                aria-label="Раздавать с"
                style={{ width: 112 }}
              />
            </span>
            <span className="nf">
              <input
                type="time"
                value={end}
                onChange={(e) => setEnd(e.target.value)}
                aria-label="Раздавать до"
                style={{ width: 112 }}
              />
            </span>
          </div>
        </div>
        <div className="wrap" style={{ marginTop: "var(--s4)" }}>
          <button className="pill ghost" type="submit" disabled={updateForm.isPending}>
            {updateForm.isPending ? "Сохранение..." : "Сохранить"}
          </button>
          {saved && <span className="saved on">Сохранено</span>}
        </div>
      </form>

      <CompanyDaysOffBlock />
    </section>
  );
}
