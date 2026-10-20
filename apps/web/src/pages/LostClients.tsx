import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight, UserX } from "lucide-react";
import { useLostClientsFeed, type LostClient } from "../hooks/useClients";
import { Pagination } from "../components/Pagination";
import { ClientsTabs } from "../components/ClientsTabs";
import { ClientsSectionLane } from "../components/ClientsSectionLane";
import { relativeTime } from "../lib/format";
import { CLIENT_KIND_LABELS, formatClientCode, formatClientName } from "../lib/clientFormat";
import { pluralizeRu } from "@royal-home/shared";
import { useMobileUx } from "../hooks/useMobileUx";
import { MobileLostClients } from "../components/mobile/MobileLostClients";
import { useCan } from "../lib/permissions";
import { initialsFromName } from "../lib/channelMeta";

/**
 * «Потерянные клиенты» — решение владельца 11.08.2026, свой раздел рядом с
 * «Горячими». Сюда попадает клиент, у которого исчерпан предел передач
 * (Настройки → Лиды): несколько агентов подряд не смогли его закрыть. Это не
 * оценка клиента, а факт про нас — раздел существует, чтобы руководство видело
 * ПОЧЕМУ, а не только то, что клиент выпал из работы.
 *
 * Цепочка отказов строится сервером из хронологии (routes/clients.ts, GET
 * /clients/lost) — тот же текст, что уже писался при каждом закрытии карточки,
 * здесь просто собран в одном месте, без похода в карточку за каждым отказом.
 *
 * ОБЛИК — тема «Royal Home 2026» (09.09.2026). Разметка и классы взяты дословно
 * из прототипа: шапка `.pg-h`, список `.list`/`.row` (screens/clients.html),
 * раскрытая цепочка — `.grp` с боковой линией из screens/activity.html,
 * состояния `.state`/`.state err`/`.empty` (договор §6.12). Шести-колоночной
 * таблицы прототип на этом экране не знает вовсе, а `.row` уже умеет прятать
 * второстепенное на узком экране (`.only-wide`) — поэтому таблица заменена
 * строками списка, а не переписана в `.tbl`: полей ровно столько же.
 */
export function LostClients() {
  // Телефон получает экран по прототипу (MobileLostClients), десктоп — как был.
  // Ветвление ДО хуков десктопной разметки (паттерн Dashboard.tsx).
  const mobile = useMobileUx();
  if (mobile) return <MobileLostClients />;
  return <LostClientsDesktop />;
}

/**
 * Из какого раздела вошли в «Потерянных» (21.09.2026): `?kind=SELLER|BUYER`.
 * Верхний уровень теперь — только «Продавцы» и «Покупатели», а «потерян» —
 * состояние внутри каждого (см. components/ClientsSectionLane.tsx). Без
 * параметра (старая ссылка, отчёт, уведомление) раздел работает как прежде —
 * показывает оба вида сразу.
 */
function useLostSection(): "SELLER" | "BUYER" | null {
  const [searchParams] = useSearchParams();
  const raw = searchParams.get("kind");
  return raw === "SELLER" ? "SELLER" : raw === "BUYER" ? "BUYER" : null;
}

function LostClientsDesktop() {
  const can = useCan();
  const section = useLostSection();
  // Раздел видит только руководство (право clients.assign, см. GET /clients/lost
  // на сервере) — но прямая ссылка на /lost-clients раньше была доступна всем
  // (пункт меню и так скрыт — ClientsTabs.tsx), и агент получал битый экран с
  // 403 в консоли вместо честного «раздел вам недоступен» (приёмка 08.09, Q4 B-2).
  const canView = can("clients.assign");
  // Страницами с «Показать ещё» (02.10.2026) — общая лента с телефоном.
  const feed = useLostClientsFeed(canView, section);
  const { items, total, isLoading, error, refetch } = feed;
  const [openId, setOpenId] = useState<string | null>(null);

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Потерянные клиенты</h1>
            </div>
          </div>
          <div className="card tight">
            <div className="state">
              Раздел про причины потери клиентов видит только руководство: вам он недоступен.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rh2 screens">
      <div className="scr">
        {/* Та же шапка и те же вкладки, что и у остальных срезов клиентов: раздел
            один, «потерянные» — его срез, а не отдельная сущность. */}
        <div className="pg-h">
          <div>
            <h1>Потерянные клиенты</h1>
            <p className="sub">
              Предел передач исчерпан: несколько агентов подряд не смогли закрыть клиента.
              {/* Сколько всего — прямо: иначе по экрану считают, что потерянных ровно
                  столько, сколько видно до «Показать ещё». */}
              {total !== undefined && total > 0 && <> Всего: {total}.</>}
            </p>
          </div>
        </div>

        <div className="card">
          <ClientsTabs />
          {/* Вторая лента раздела — та же, что на «Продавцах» и «Покупателях».
              Без неё из «Потерянных» некуда было вернуться в свой раздел одним
              нажатием. Раздел определяется адресом; пришли по старой ссылке без
              него — считаем покупателями, лента всё равно ведёт в оба. */}
          <ClientsSectionLane section={section ?? "BUYER"} />

          {/* Главная мысль раздела тихой строкой, а не карточкой-уведомлением
              (договор §6.1): список не должен читаться как «чёрный список клиентов». */}
          <div className="quiet" style={{ marginTop: 8 }}>
            <span className="dot" />
            <span className="txt">
              Раздел про нас, а не про клиента: несколько агентов подряд не смогли закрыть.
            </span>
          </div>

          {/* Состояния блока: ошибка, загрузка, пусто — тихими строками (договор §6.12) */}
          {error && (
            <div className="state err">
              <span className="dot crit" />
              Список не загрузился.
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => refetch()}
              >
                Повторить
              </button>
            </div>
          )}

          {isLoading && !error && (
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" />
              Загружаем потерянных клиентов
            </div>
          )}

          {!isLoading && !error && items.length === 0 && (
            <div className="empty">
              <span className="ic">
                <UserX className="i" />
              </span>
              <p>Потерянных клиентов нет.</p>
              <span className="sub">
                Как только предел передач по какому-то клиенту исчерпается, он появится здесь со
                всей цепочкой причин.
              </span>
            </div>
          )}

          {items.length > 0 && (
            <div className="list" style={{ marginTop: 8 }}>
              {items.map((client) => (
                <LostClientRow
                  key={client.id}
                  client={client}
                  open={openId === client.id}
                  onToggle={() => setOpenId(openId === client.id ? null : client.id)}
                />
              ))}
            </div>
          )}
          {total !== undefined && (
            <Pagination
              variant="loadMore"
              page={feed.page}
              pageSize={feed.pageSize}
              total={total}
              onPageChange={feed.setPage}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function LostClientRow({
  client,
  open,
  onToggle,
}: {
  client: LostClient;
  open: boolean;
  onToggle: () => void;
}) {
  // Подпись типа — из общего словаря (packages/shared/src/format.ts), а не из
  // «SELLER ? Продавец : Покупатель»: прочее обращение эта развилка называла
  // покупателем.
  const kindLabel = CLIENT_KIND_LABELS[client.kind];
  // «Переходов», а не «отказов»: refusalCount — общий счётчик перемещений
  // карточки между агентами, и передачи считаются им наравне с отказами.
  // Клиента, которого трижды ПЕРЕДАЛИ без единого отказа, подпись
  // «3 отказ(а/ов)» описывала неверно — да и сама форма «отказ(а/ов)»
  // была заглушкой, а не русским текстом.
  const refusalsLine = `${client.refusalCount} ${pluralizeRu(client.refusalCount, [
    "переход",
    "перехода",
    "переходов",
  ])}`;

  return (
    <>
      <div className="row">
        <span className="av">{initialsFromName(formatClientName(client))}</span>
        <div className="t">
          <b>
            {/* Раскрытие цепочки — по имени (`.lk` прототипа): растянутой ссылки
                поверх строки в макете нет, а «Открыть карточку» справа осталась
                отдельной целью, как была. */}
            {/* `.lk` в эталоне не флекс на широком экране, поэтому значок и подпись
                разъезжались бы по строкам — тот же инлайн-приём, что у крошки в
                ClientDetail.tsx (прототип сам пользуется инлайновыми стилями). */}
            <button
              className="lk"
              type="button"
              aria-expanded={open}
              onClick={onToggle}
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
            >
              {open ? <ChevronDown className="i" /> : <ChevronRight className="i" />}
              {formatClientName(client)}
            </button>
          </b>
          <span>
            {/* Номер карточки — ТЗ п. 2, «в списках». Приставка по типу клиента. */}
            {formatClientCode(client.shortId, client.kind)} · {kindLabel} · {client.phone}
            {client.lastReason ? ` · ${client.lastReason}` : ""}
          </span>
        </div>
        <span className="chip crit">{refusalsLine}</span>
        <span className="meta only-wide">{client.lostAt ? relativeTime(client.lostAt) : "нет даты"}</span>
        <div className="act">
          <Link className="pill ghost sm" to={`/clients/${client.shortId}`}>
            Открыть
          </Link>
        </div>
      </div>

      {open && (
        <div className="grp">
          <div className="side">
            <span className="av">{initialsFromName(formatClientName(client))}</span>
            <span className="ln" />
          </div>
          <div className="body">
            {/* Цепочка — кто вёл клиента и что записал при закрытии, по порядку.
                Именно это владелец просил видеть, не открывая карточку по одной. */}
            <div className="hd">
              <span className="who">Цепочка передач</span>
              <span className="when">{refusalsLine}</span>
            </div>
            {client.chain.map((hop, i) => (
              <div className="ev-l" key={i}>
                <span className="kind">{hop.agentName}</span>
                <span className="txt">{hop.notes}</span>
                <span className="tm">{relativeTime(hop.at)}</span>
              </div>
            ))}
            {client.chain.length === 0 && <p className="more">Записей о передачах нет.</p>}
          </div>
        </div>
      )}
    </>
  );
}
