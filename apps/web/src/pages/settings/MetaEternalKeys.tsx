import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";
import { KeyRound, Megaphone, MessageCircle, Phone } from "lucide-react";
import {
  META_ETERNAL_STATE_LABEL,
  metaCompanyPagesSchema,
  metaEternalStatusSchema,
  metaLoginAssetsSchema,
  metaLoginConnectResultSchema,
  metaLoginStartSchema,
  type MetaCompanyPage,
  type MetaEternalKeyRow,
  type MetaEternalStatus,
  type MetaLoginConnectResult,
} from "@royal-home/shared";
import { api } from "../../lib/api";
import { SwitchRow } from "../../components/Switch";
import { dushanbeDateTime } from "../../lib/date";
import {
  EMPTY_SELECTION,
  defaultMetaLoginSelection,
  readMetaLoginParam,
  selectionSize,
  selectionToInput,
  toggleInSelection,
  whatsappNumberHint,
  withoutMetaLoginParams,
  type MetaLoginSelection,
} from "../../lib/metaLoginSelection";

/**
 * ВЕЧНЫЕ КЛЮЧИ META (12.11.2026).
 *
 * Смена пароля Instagram 11.11 убила личный маркер — бот замолчал. Здесь видно,
 * какой канал может работать от ключа компании (системный пользователь) и что
 * для этого докликать. Честно: пока Meta не одобрила приложению расширенный
 * доступ (App Review), путь через Страницу отвечает только людям с ролью в
 * приложении — поэтому для клиентов он заблокирован до отметки директора.
 * Самопроверка работает при любом положении рубильника. Один экран для
 * компьютера и телефона: строки `.row` переносятся сами, кнопки в `.wrap`.
 */
const QUERY_KEY = ["meta-eternal"];

/** Тумблер переключается сразу (правило владельца 11.08), откат — при отказе. */
function optimistic(client: ReturnType<typeof useQueryClient>, field: "preferred" | "appReviewApproved") {
  return {
    onMutate: async (value: boolean) => {
      await client.cancelQueries({ queryKey: QUERY_KEY });
      const before = client.getQueryData<MetaEternalStatus>(QUERY_KEY);
      if (before) client.setQueryData<MetaEternalStatus>(QUERY_KEY, { ...before, [field]: value });
      return { before };
    },
    onError: (_err: unknown, _value: boolean, ctx: { before?: MetaEternalStatus } | undefined) => {
      if (ctx?.before) client.setQueryData(QUERY_KEY, ctx.before);
    },
  };
}

export function MetaEternalKeys() {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => metaEternalStatusSchema.parse(await api("/settings/meta-eternal")),
    staleTime: 60_000,
  });
  const refresh = () => client.invalidateQueries({ queryKey: QUERY_KEY });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api("/settings/meta-eternal/preferred", { method: "PUT", body: { enabled } }),
    ...optimistic(client, "preferred"),
    onSettled: refresh,
  });
  const review = useMutation({
    mutationFn: (approved: boolean) => api("/settings/meta-eternal/app-review", { method: "PUT", body: { approved } }),
    ...optimistic(client, "appReviewApproved"),
    onSettled: refresh,
  });
  const findPage = useMutation({
    mutationFn: (accountId: string) => api(`/settings/meta-eternal/accounts/${accountId}/page`, { method: "POST", body: {} }),
    meta: { successText: "Страница найдена и проверена" },
    onSettled: refresh,
  });
  const subscribe = useMutation({
    mutationFn: (pageId: string) => api(`/settings/meta-eternal/pages/${pageId}/subscribe`, { method: "POST", body: {} }),
    meta: { successText: "Страница подписана на сообщения" },
    onSettled: refresh,
  });

  const data = status.data;
  const busy = findPage.isPending || subscribe.isPending;

  return (
    <div style={{ marginTop: "var(--s4)" }}>
      <FacebookLogin />

      <div className="sec-h stack" style={{ marginTop: "var(--s4)" }}>
        <h2>Вечные ключи</h2>
        <span className="note">Ключ компании вместо личных: смена пароля сотрудника его не ломает</span>
      </div>

      <SwitchRow
        title="Ключ компании вместо личных"
        on={data?.preferred ?? false}
        disabled={!data || toggle.isPending}
        onToggle={() => data && toggle.mutate(!data.preferred)}
        hint={
          data?.preferred
            ? data.appReviewApproved
              ? "Переписка и реклама берут ключ компании, где он готов. Личные ключи — запасные."
              : "Реклама берёт ключ компании, где он готов. Переписка — личными ключами, пока Meta не одобрит приложение."
            : "Работают только личные ключи сотрудников — их сломает смена пароля."
        }
      />
      <SwitchRow
        title="Meta одобрила приложение (App Review)"
        on={data?.appReviewApproved ?? false}
        disabled={!data || review.isPending}
        onToggle={() => data && review.mutate(!data.appReviewApproved)}
        hint={
          data?.appReviewApproved
            ? "Отмечено: расширенный доступ к pages_messaging и instagram_manage_messages выдан — ключ компании может отвечать клиентам."
            : "Не отмечено: без расширенного доступа к pages_messaging и instagram_manage_messages ответ через Страницу дойдёт только людям с ролью в приложении. Отметьте, когда Meta одобрит (developers.facebook.com → приложение → App Review)."
        }
      />

      {status.isPending && <p className="quiet">Проверяю ключи…</p>}
      {status.isError && <p className="quiet" role="alert">Не удалось проверить ключи. Обновите страницу.</p>}

      {data && (
        <>
          <p className="quiet">
            {data.systemUser.ok
              ? `Ключ компании работает${data.systemUser.name ? ` (${data.systemUser.name})` : ""}.` +
                (data.systemUser.missingScopes.length ? ` Не хватает прав: ${data.systemUser.missingScopes.join(", ")}.` : "")
              : data.systemUser.configured
                ? `Ключ компании не работает: ${data.systemUser.detail ?? "Meta не ответила"}.`
                : "Ключ компании не задан — вставьте его в поле «Маркер удаления Instagram» ниже."}
          </p>
          {data.rows.length > 0 && (
            <div className="list" style={{ marginTop: "var(--s3)" }}>
              {data.rows.map((row) => (
                <EternalRow
                  key={row.key}
                  row={row}
                  busy={busy}
                  onFindPage={(id) => findPage.mutate(id)}
                  onSubscribe={(pageId) => subscribe.mutate(pageId)}
                />
              ))}
            </div>
          )}
          <CompanyPages />
          <div className="wrap" style={{ marginTop: "var(--s3)" }}>
            <button className="pill ghost sm" type="button" disabled={status.isFetching} onClick={refresh}>
              Проверить ещё раз
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function EternalRow({
  row,
  busy,
  onFindPage,
  onSubscribe,
}: {
  row: MetaEternalKeyRow;
  busy: boolean;
  onFindPage: (accountId: string) => void;
  onSubscribe: (pageId: string) => void;
}) {
  const ok = row.state === "ready";
  const calm = ok || row.state === "pending_first_send" || row.state === "off";
  const canFind = row.channel === "INSTAGRAM" && !!row.accountId && ["no_page", "mismatch", "page_not_shared"].includes(row.state);
  const canSubscribe = ok && row.subscribed === false && !!row.pageId;
  return (
    <div className="row">
      <KeyRound className="i lg" aria-hidden="true" />
      <div className="t">
        <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
          <span>{row.title}</span>
          <span className={`chip ${ok ? "ok" : calm ? "" : "crit"}`}>{META_ETERNAL_STATE_LABEL[row.state]}</span>
        </b>
        {row.pageName && <span>Страница: {row.pageName}</span>}
        {row.lastSentAt && (
          <span>
            Последняя отправка ключом компании: {dushanbeDateTime(row.lastSentAt)}
          </span>
        )}
        {row.hint && <span className="quiet">{row.hint}</span>}
        {(canFind || canSubscribe) && (
          <div className="wrap" style={{ marginTop: "var(--s2)" }}>
            {canFind && row.accountId && (
              <button className="pill sm" type="button" disabled={busy} onClick={() => onFindPage(row.accountId!)}>
                Найти Страницу
              </button>
            )}
            {canSubscribe && row.pageId && (
              <button className="pill sm" type="button" disabled={busy} onClick={() => onSubscribe(row.pageId!)}>
                Подписать Страницу
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const PAGES_KEY = ["meta-eternal", "pages"];

/**
 * СТРАНИЦЫ FACEBOOK КЛЮЧА КОМПАНИИ (13.11.2026). Страница другой компании
 * (Arvan estate), выданная системному пользователю, подключается одной кнопкой:
 * маркер берёт сервер, человек его не видит и не копирует.
 */
function CompanyPages() {
  const client = useQueryClient();
  const pages = useQuery({
    queryKey: PAGES_KEY,
    queryFn: async () => metaCompanyPagesSchema.parse(await api("/settings/meta-eternal/pages")),
    staleTime: 60_000,
  });
  const done = () => {
    void client.invalidateQueries({ queryKey: PAGES_KEY });
    void client.invalidateQueries({ queryKey: QUERY_KEY });
  };
  const connect = useMutation({
    mutationFn: (pageId: string) => api(`/settings/meta-eternal/pages/${pageId}/connect`, { method: "POST", body: {} }),
    meta: { successText: "Messenger Страницы подключён" },
    onSettled: done,
  });
  const subscribe = useMutation({
    mutationFn: (pageId: string) => api(`/settings/meta-eternal/pages/${pageId}/subscribe`, { method: "POST", body: {} }),
    meta: { successText: "Страница подписана на сообщения" },
    onSettled: done,
  });
  const list = pages.data?.pages ?? [];
  if (pages.isPending) return null;
  return (
    <>
      <div className="sec-t" style={{ marginTop: "var(--s4)" }}>Страницы Facebook ключа компании</div>
      {pages.data?.error && <p className="quiet">Список не получен: {pages.data.error}</p>}
      {pages.isError && <p className="quiet" role="alert">Не удалось получить Страницы. Обновите страницу.</p>}
      {!pages.data?.error && list.length === 0 && pages.isSuccess && (
        <p className="quiet">Системному пользователю пока не выдана ни одна Страница.</p>
      )}
      {list.length > 0 && (
        <div className="list" style={{ marginTop: "var(--s2)" }}>
          {list.map((page) => (
            <CompanyPageRow
              key={page.id}
              page={page}
              busy={connect.isPending || subscribe.isPending}
              onConnect={() => connect.mutate(page.id)}
              onSubscribe={() => subscribe.mutate(page.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}

function CompanyPageRow({
  page,
  busy,
  onConnect,
  onSubscribe,
}: {
  page: MetaCompanyPage;
  busy: boolean;
  onConnect: () => void;
  onSubscribe: () => void;
}) {
  const label = page.connected
    ? page.subscribed === false
      ? "Подключена, сообщения не приходят"
      : "Messenger подключён"
    : page.canMessage
      ? "Не подключена"
      : "Нет доступа к сообщениям";
  const ok = Boolean(page.connected) && page.subscribed !== false;
  return (
    <div className="row">
      <MessageCircle className="i lg" aria-hidden="true" />
      <div className="t">
        <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
          <span>{page.name}</span>
          <span className={`chip ${ok ? "ok" : page.canMessage ? "" : "crit"}`}>{label}</span>
        </b>
        {/* div, а не span: на телефоне тема режет `.row .t span` до двух строк,
            и подсказка «что нажать» обрывалась на полуслове. */}
        <div className="quiet">
          {page.connected === "settings"
            ? "Основная Страница: отвечает через настройки Facebook выше."
            : page.connected === "account"
              ? "Бот отвечает в Messenger этой Страницы. Имя компании и промт — в списке аккаунтов ниже."
              : page.canMessage
                ? "Нажмите «Подключить Messenger» — бот начнёт отвечать в сообщениях этой Страницы."
                : "Выдайте системному пользователю задачу «Сообщения» на этой Странице (Business Suite → Системные пользователи → Назначить ресурсы)."}
        </div>
        {(page.canMessage && page.connected !== "settings") || (page.connected && page.subscribed === false) ? (
          <div className="wrap" style={{ marginTop: "var(--s2)" }}>
            {page.canMessage && page.connected !== "settings" && (
              <button className="pill sm" type="button" disabled={busy} onClick={onConnect}>
                {page.connected === "account" ? "Обновить ключ" : "Подключить Messenger"}
              </button>
            )}
            {page.connected && page.subscribed === false && (
              <button className="pill sm" type="button" disabled={busy} onClick={onSubscribe}>
                Подписать Страницу
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// ───────────────────────── Вход через Facebook (13.11.2026) ─────────────────────────

const LOGIN_KEY = ["meta-eternal", "login"];

/**
 * «ВОЙТИ ЧЕРЕЗ FACEBOOK». Просьба владельца: «чтобы любую страницу подключали с
 * настроек CRM: нажать „Войти через Facebook“, дать разрешения — и всё, без игры
 * с токенами». Кнопка ведёт в окно Facebook; Facebook возвращает сюда с
 * ?metaLogin=<id> — показываем найденное галочками, «Подключить выбранное»,
 * итог по строкам. Ключи видит только сервер. Один экран для ПК и телефона:
 * строки `.row` переносятся, кнопки в `.wrap`, подсказки — в div (тема режет
 * `.row .t span` до двух строк на телефоне).
 */
function FacebookLogin() {
  const [searchParams, setSearchParams] = useSearchParams();
  const param = readMetaLoginParam(searchParams);
  const sessionId = param?.kind === "session" ? param.id : null;
  const [results, setResults] = useState<MetaLoginConnectResult | null>(null);

  const start = useMutation({
    mutationFn: async () => metaLoginStartSchema.parse(await api("/settings/meta-eternal/login", { method: "POST", body: {} })),
    onSuccess: ({ url }) => window.location.assign(url),
  });

  const close = () => setSearchParams(withoutMetaLoginParams(searchParams), { replace: true });

  return (
    <>
      <div className="sec-h stack">
        <h2>Подключить через Facebook</h2>
        <span className="note">Войдите своим Facebook — CRM сама найдёт Страницы, Instagram, номера WhatsApp и рекламные кабинеты</span>
      </div>
      <div className="quiet" style={{ marginBottom: "var(--s2)" }}>
        Свои Страницы, Instagram и WhatsApp заработают сразу. Чтобы бот отвечал клиентам чужих компаний, Meta должна одобрить
        приложение — до этого ответы доходят только людям с ролью в приложении.
      </div>
      <div className="wrap">
        <button className="pill" type="button" disabled={start.isPending} onClick={() => start.mutate()}>
          {start.isPending ? "Открываю Facebook…" : "Войти через Facebook"}
        </button>
      </div>
      {start.isError && (
        <div className="quiet" role="alert">
          {start.error instanceof Error ? start.error.message : "Не удалось открыть вход через Facebook"}
        </div>
      )}
      {param?.kind === "error" && (
        <div className="quiet" role="alert" style={{ marginTop: "var(--s2)" }}>
          {param.message}{" "}
          <button className="pill ghost sm" type="button" onClick={close}>Понятно</button>
        </div>
      )}
      {sessionId && <LoginChoice sessionId={sessionId} onDone={(r) => { setResults(r); close(); }} />}
      {results && <LoginResults results={results} onClose={() => setResults(null)} />}
    </>
  );
}

function LoginChoice({ sessionId, onDone }: { sessionId: string; onDone: (r: MetaLoginConnectResult) => void }) {
  const client = useQueryClient();
  const assets = useQuery({
    queryKey: [...LOGIN_KEY, sessionId],
    queryFn: async () => metaLoginAssetsSchema.parse(await api(`/settings/meta-eternal/login/${sessionId}`)),
    retry: false,
    staleTime: Infinity,
  });
  const [selection, setSelection] = useState<MetaLoginSelection>(EMPTY_SELECTION);
  useEffect(() => {
    if (assets.data) setSelection(defaultMetaLoginSelection(assets.data));
  }, [assets.data]);

  const connect = useMutation({
    mutationFn: async () =>
      metaLoginConnectResultSchema.parse(
        await api(`/settings/meta-eternal/login/${sessionId}/connect`, { method: "POST", body: selectionToInput(selection) })
      ),
    onSuccess: (r) => {
      void client.invalidateQueries({ queryKey: QUERY_KEY });
      void client.invalidateQueries({ queryKey: ["settings"] });
      onDone(r);
    },
  });

  if (assets.isPending) return <p className="quiet">Смотрю, что выдал Facebook…</p>;
  if (assets.isError || !assets.data) {
    return (
      <div className="quiet" role="alert" style={{ marginTop: "var(--s2)" }}>
        {assets.error instanceof Error ? assets.error.message : "Вход не найден или устарел — войдите через Facebook заново."}
      </div>
    );
  }
  const data = assets.data;
  const pick = (kind: keyof MetaLoginSelection, id: string) => (on: boolean) => setSelection((s) => toggleInSelection(s, kind, id, on));
  const nothing = data.pages.length === 0 && data.adAccounts.length === 0 && data.whatsapp.length === 0;

  return (
    <div style={{ marginTop: "var(--s3)" }}>
      {data.warnings.map((w) => (
        <div key={w} className="quiet">{w}</div>
      ))}
      {nothing && <p className="quiet">Facebook не выдал ни одной Страницы, номера WhatsApp и кабинета. Войдите ещё раз и отметьте их в окне Facebook.</p>}
      <LoginSection title="Страницы Facebook" empty={data.pages.length === 0}>
        {data.pages.map((p) => (
          <ChoiceRow
            key={p.id}
            icon="page"
            title={p.name}
            hint={
              p.connected === "settings"
                ? "Основная Страница — уже отвечает через настройки Facebook."
                : !p.canMessage
                  ? "У вас нет доступа к сообщениям этой Страницы."
                  : `Messenger этой Страницы.${p.ig ? ` Instagram: ${p.ig.username ? `@${p.ig.username}` : "привязан"}.` : ""} Ролики на Facebook пока публикуются только на основную Страницу.`
            }
            connected={Boolean(p.connected)}
            disabled={p.connected === "settings" || !p.canMessage}
            checked={selection.pages.includes(p.id)}
            onChange={pick("pages", p.id)}
          />
        ))}
      </LoginSection>
      <LoginSection title="Instagram" empty={data.instagram.length === 0}>
        {data.instagram.map((i) => (
          <ChoiceRow
            key={i.id}
            icon="page"
            title={i.username ? `@${i.username}` : `Instagram Страницы «${i.pageName}»`}
            hint={
              i.connected === "account"
                ? `Уже в CRM со своим ключом. Отметьте, чтобы привязать к Странице «${i.pageName}».`
                : `Отвечает через Страницу «${i.pageName}». Ролики объектов идут в основной Instagram, этот можно выбрать для свободных роликов.`
            }
            connected={i.connected === "page"}
            checked={selection.instagram.includes(i.id)}
            onChange={pick("instagram", i.id)}
          />
        ))}
      </LoginSection>
      <LoginSection title="WhatsApp" empty={data.whatsapp.length === 0}>
        {data.keyKind !== "business" && (
          <div className="row">
            <div className="t">
              <div className="quiet">
                {data.keyKind === "personal"
                  ? "Ключ личный: WhatsApp перестанет отвечать, если сменить пароль Facebook."
                  : "Не удалось проверить, чей ключ: если он личный, WhatsApp перестанет отвечать после смены пароля Facebook."}{" "}
                Для постоянной работы впишите ниже номер конфигурации входа с ключом компании и войдите заново.
              </div>
            </div>
          </div>
        )}
        {data.whatsapp.map((n) => (
          <ChoiceRow
            key={n.id}
            icon="whatsapp"
            title={[n.name, n.phone].filter(Boolean).join(" · ") || `Номер ${n.id}`}
            hint={whatsappNumberHint(n)}
            connected={Boolean(n.connected)}
            disabled={n.connected === "settings"}
            checked={selection.whatsapp.includes(n.id)}
            onChange={pick("whatsapp", n.id)}
          />
        ))}
      </LoginSection>
      <LoginSection title="Рекламные кабинеты" empty={data.adAccounts.length === 0}>
        {data.adAccounts.map((a) => (
          <ChoiceRow
            key={a.id}
            icon="ads"
            title={a.name}
            hint={`${a.id}${a.status !== null && a.status !== 1 ? " · кабинет ограничен или закрыт" : ""}. Расходы и заявки попадут в отчёт по рекламе.`}
            connected={a.connected}
            checked={selection.adAccounts.includes(a.id)}
            onChange={pick("adAccounts", a.id)}
          />
        ))}
      </LoginSection>
      {!nothing && (
        <div className="wrap" style={{ marginTop: "var(--s3)" }}>
          <button className="pill" type="button" disabled={connect.isPending || selectionSize(selection) === 0} onClick={() => connect.mutate()}>
            {connect.isPending ? "Подключаю…" : "Подключить выбранное"}
          </button>
        </div>
      )}
      {connect.isError && (
        <div className="quiet" role="alert">
          {connect.error instanceof Error ? connect.error.message : "Не удалось подключить"}
        </div>
      )}
    </div>
  );
}

function LoginSection({ title, empty, children }: { title: string; empty: boolean; children: ReactNode }) {
  if (empty) return null;
  return (
    <>
      <div className="sec-t" style={{ marginTop: "var(--s3)" }}>{title}</div>
      <div className="list" style={{ marginTop: "var(--s2)" }}>{children}</div>
    </>
  );
}

function ChoiceRow({
  icon,
  title,
  hint,
  connected,
  disabled,
  checked,
  onChange,
}: {
  icon: "page" | "ads" | "whatsapp";
  title: string;
  hint: string;
  connected: boolean;
  disabled?: boolean;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  const Icon = icon === "ads" ? Megaphone : icon === "whatsapp" ? Phone : MessageCircle;
  return (
    <label className="row" style={{ cursor: disabled ? "default" : "pointer" }}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={title} />
      <Icon className="i lg" aria-hidden="true" />
      <div className="t">
        <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
          <span>{title}</span>
          {connected && <span className="chip ok">подключено</span>}
        </b>
        <div className="quiet">{hint}</div>
      </div>
    </label>
  );
}

const KIND_TITLE: Record<MetaLoginConnectResult["results"][number]["kind"], string> = {
  page: "Страница",
  instagram: "Instagram",
  adAccount: "Кабинет",
  whatsapp: "WhatsApp",
};

function LoginResults({ results, onClose }: { results: MetaLoginConnectResult; onClose: () => void }) {
  return (
    <div style={{ marginTop: "var(--s3)" }} role="status">
      <div className="sec-t">Итог подключения</div>
      <div className="list" style={{ marginTop: "var(--s2)" }}>
        {results.results.map((r) => (
          <div className="row" key={`${r.kind}:${r.id}`}>
            <div className="t">
              <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
                <span>{KIND_TITLE[r.kind]} {r.name}</span>
                <span className={`chip ${r.ok ? "ok" : "crit"}`}>{r.ok ? "готово" : "не подключено"}</span>
              </b>
              <div className="quiet">{r.message}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="wrap" style={{ marginTop: "var(--s2)" }}>
        <button className="pill ghost sm" type="button" onClick={onClose}>Закрыть</button>
      </div>
    </div>
  );
}

