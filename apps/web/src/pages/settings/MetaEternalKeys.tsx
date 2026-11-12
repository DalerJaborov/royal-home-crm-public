import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { META_ETERNAL_STATE_LABEL, metaEternalStatusSchema, type MetaEternalKeyRow, type MetaEternalStatus } from "@royal-home/shared";
import { api } from "../../lib/api";
import { SwitchRow } from "../../components/Switch";

/**
 * ВЕЧНЫЕ КЛЮЧИ META (12.11.2026).
 *
 * Смена пароля Instagram 11.11 убила личный маркер — бот замолчал. Здесь видно,
 * какой канал уже работает от ключа компании (системный пользователь), а
 * какому нужно докликать доступ, и одна кнопка на каждый шаг. Один экран для
 * компьютера и телефона: строки `.row` переносятся сами, кнопки в `.wrap`.
 */
const QUERY_KEY = ["meta-eternal"];

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
    // Тумблер переключается сразу (правило владельца 11.08), откат — при отказе.
    onMutate: async (enabled: boolean) => {
      await client.cancelQueries({ queryKey: QUERY_KEY });
      const before = client.getQueryData<MetaEternalStatus>(QUERY_KEY);
      if (before) client.setQueryData<MetaEternalStatus>(QUERY_KEY, { ...before, preferred: enabled });
      return { before };
    },
    onError: (_err, _enabled, ctx) => { if (ctx?.before) client.setQueryData(QUERY_KEY, ctx.before); },
    onSettled: refresh,
  });
  const findPage = useMutation({
    mutationFn: (accountId: string) => api(`/settings/meta-eternal/accounts/${accountId}/page`, { method: "POST", body: {}, queueOffline: false }),
    meta: { successText: "Страница найдена и проверена" },
    onSettled: refresh,
  });
  const subscribe = useMutation({
    mutationFn: (pageId: string) => api(`/settings/meta-eternal/pages/${pageId}/subscribe`, { method: "POST", body: {}, queueOffline: false }),
    meta: { successText: "Страница подписана на сообщения" },
    onSettled: refresh,
  });

  const data = status.data;
  const busy = findPage.isPending || subscribe.isPending;

  return (
    <div style={{ marginTop: "var(--s4)" }}>
      <div className="sec-h stack">
        <h2>Вечные ключи</h2>
        <span className="note">Переписка идёт ключом компании — смена пароля сотрудника её не ломает</span>
      </div>

      <SwitchRow
        title="Ключ компании вместо личных"
        on={data?.preferred ?? true}
        disabled={!data || toggle.isPending}
        onToggle={() => data && toggle.mutate(!data.preferred)}
        hint={
          (data?.preferred ?? true)
            ? "Instagram, Facebook и отчёт по рекламе берут ключ компании, если он готов. Личные ключи — запасные."
            : "Работают только личные ключи сотрудников — их сломает смена пароля."
        }
      />

      {status.isPending && <p className="quiet">Проверяю ключи…</p>}
      {status.isError && <p className="quiet" role="alert">Не удалось проверить ключи. Обновите страницу.</p>}

      {data && (
        <>
          <p className="quiet">
            {data.systemUser.ok
              ? `Ключ компании работает${data.systemUser.name ? ` (${data.systemUser.name})` : ""}.`
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
  const canFind = row.channel === "INSTAGRAM" && !!row.accountId && ["no_page", "mismatch", "page_not_shared"].includes(row.state);
  const canSubscribe = ok && row.subscribed === false && !!row.pageId;
  return (
    <div className="row">
      <KeyRound className="i lg" aria-hidden="true" />
      <div className="t">
        <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
          <span>{row.title}</span>
          <span className={`chip ${ok ? "ok" : row.state === "off" ? "" : "crit"}`}>{META_ETERNAL_STATE_LABEL[row.state]}</span>
        </b>
        {row.pageName && <span>Страница: {row.pageName}</span>}
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
