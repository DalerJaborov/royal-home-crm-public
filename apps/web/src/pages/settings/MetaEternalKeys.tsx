import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, MessageCircle } from "lucide-react";
import {
  META_ETERNAL_STATE_LABEL,
  metaCompanyPagesSchema,
  metaEternalStatusSchema,
  type MetaCompanyPage,
  type MetaEternalKeyRow,
  type MetaEternalStatus,
} from "@royal-home/shared";
import { api } from "../../lib/api";
import { SwitchRow } from "../../components/Switch";
import { dushanbeDateTime } from "../../lib/date";

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
      <div className="sec-h stack">
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
        <span className="quiet">
          {page.connected === "settings"
            ? "Основная Страница: отвечает через настройки Facebook выше."
            : page.connected === "account"
              ? "Бот отвечает в Messenger этой Страницы. Имя компании и промт — в списке аккаунтов ниже."
              : page.canMessage
                ? "Нажмите «Подключить Messenger» — бот начнёт отвечать в сообщениях этой Страницы."
                : "Выдайте системному пользователю задачу «Сообщения» на этой Странице (Business Suite → Системные пользователи → Назначить ресурсы)."}
        </span>
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
