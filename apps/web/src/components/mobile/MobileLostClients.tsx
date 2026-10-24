import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronRight } from "lucide-react";
import { pluralizeRu } from "@royal-home/shared";
import { useLostClientsFeed, type LostClient } from "../../hooks/useClients";
import { Pagination } from "../Pagination";
import { MhLane, MhListScreen } from "./mh/MhList";
import { useClientSectionChips } from "./mh/MhClientSections";
import { MhNoData, MhQuiet } from "../home/mh/MhScreen";
import { relativeTime } from "../../lib/format";
import { formatClientCode, formatClientName } from "../../lib/clientFormat";
import { avatarInitial, avatarToneClass } from "../../lib/avatarTone";
import { useCan } from "../../lib/permissions";

/**
 * «ПОТЕРЯННЫЕ КЛИЕНТЫ» НА ТЕЛЕФОНЕ — переодето 17.09.2026 в облик макета
 * владельца (`.rh2 .mh`), ровно тем же приёмом и из того же файла-источника,
 * что «Покупатели»: `pages/Clients.tsx` (шапка
 * `MhListScreen`, лента разделов `MhLane`, карточка-список `.card-s` + `.list`
 * + `.row`, тихие строки `MhQuiet`/`MhNoData`).
 *
 * ЧТО БЫЛО НЕ ТАК. Экран рисовал ПК-эталон `.rh2 .screens > .scr` (`.pg-h`,
 * `.card tight`, десктопные вкладки `ClientsTabs`, `.empty` с большой
 * иконкой). Соседний раздел того же списка, открываемый прямо с «Покупателей»,
 * выглядел из другой программы — слова владельца 15.09: «всё как будто с
 * компьютера берёт, а не из макета».
 *
 * ДАННЫЕ И ПОВЕДЕНИЕ — ОБЩИЕ С ДЕСКТОПОМ: та же лента страниц
 * (`useLostClientsFeed`, «Показать ещё» с 02.10.2026), та же граница по
 * праву `clients.assign`, то же раскрытие цепочки передач по нажатию на имя
 * (ради неё раздел и заведён, решение владельца 11.08.2026).
 *
 * ЦЕПОЧКА ПЕРЕДАЧ. В макете строки-раскрытия нет вовсе, поэтому взят
 * ближайший существующий вид: вложенная карточка `.card-s` с обычными
 * строками `.row` (агент в `.n`, запись при закрытии в `.s`, давность
 * справа) — та же разметка, что у всех списков телефона, а не третий облик.
 */
export function MobileLostClients() {
  const can = useCan();
  // Раздел видит только руководство (право clients.assign) — прямая ссылка
  // была доступна всем, агент получал 403 и битый экран (приёмка 08.09, Q4 B-2).
  const canView = can("clients.assign");
  /**
   * Из какого раздела вошли (21.09.2026): «Потерянные» — состояние ВНУТРИ
   * «Продавцов» или «Покупателей», а не отдельный раздел верхнего уровня.
   * Отбор серверный: список идёт страницами, и фильтр по полученной
   * странице соврал бы ровно там, где потерянных много.
   */
  const [searchParams] = useSearchParams();
  const rawKind = searchParams.get("kind");
  const section: "SELLER" | "BUYER" | null =
    rawKind === "SELLER" ? "SELLER" : rawKind === "BUYER" ? "BUYER" : null;
  // Страницами с «Показать ещё» (02.10.2026) — общая лента с десктопом.
  const feed = useLostClientsFeed(canView, section);
  const { items, total, isLoading, error, refetch } = feed;
  const [openId, setOpenId] = useState<string | null>(null);
  const sections = useClientSectionChips("lost");

  if (!canView) {
    return (
      <MhListScreen title="Потерянные">
        <div className="sec" style={{ marginTop: 14 }}>
          <MhNoData tone="warn">
            Раздел про причины потери клиентов видит только руководство: вам он недоступен.
          </MhNoData>
        </div>
      </MhListScreen>
    );
  }

  return (
    <MhListScreen
      title={section === "SELLER" ? "Потерянные продавцы" : section === "BUYER" ? "Потерянные покупатели" : "Потерянные"}
      count={total ?? null}
    >
      {sections.length > 0 && <MhLane label="Другие разделы клиентов" chips={sections} />}

      {/* Главная мысль раздела тихой строкой (договор §6.1), чтобы список не
          читался как «чёрный список клиентов». */}
      <div className="sec" style={{ marginTop: 10 }}>
        <MhQuiet>Раздел про нас, а не про клиента: несколько агентов подряд не смогли закрыть.</MhQuiet>
      </div>

      <div className="sec" style={{ marginTop: 4 }}>
        <div className="list">
          {error ? (
            <div className="state err">
              Список не загрузился.
              <button type="button" className="lnk" onClick={() => refetch()}>
                Повторить
              </button>
            </div>
          ) : isLoading ? (
            <div className="state">Загружаем потерянных</div>
          ) : items.length === 0 ? (
            <div className="state">
              Потерянных клиентов нет. Как только предел передач по какому-то клиенту исчерпается, он появится
              здесь со всей цепочкой причин.
            </div>
          ) : (
            items.map((client) => (
              <MobileLostRow
                key={client.id}
                client={client}
                open={openId === client.id}
                onToggle={() => setOpenId(openId === client.id ? null : client.id)}
              />
            ))
          )}
        </div>
      </div>

      {/* Остальные — кнопкой «Показать ещё» (02.10.2026), вместо прежнего
          «Показаны последние N из M» без способа увидеть дальше. */}
      {total !== undefined && (
        <div className="sec">
          <Pagination
            loading={feed.isFetching}
            variant="loadMore"
            page={feed.page}
            pageSize={feed.pageSize}
            total={total}
            onPageChange={feed.setPage}
          />
        </div>
      )}
    </MhListScreen>
  );
}

/**
 * Строка потерянного клиента: `.row` макета — аватар-инициал пастельного тона,
 * имя с чипом числа переходов, причина потери отдельной строкой `.s warn`
 * (она и есть суть раздела), справа стрелка раскрытия.
 *
 * Строка целиком не ведёт в карточку, как в макете: нажатие занято цепочкой
 * передач. Карточка открывается отдельной кнопкой справа.
 */
function MobileLostRow({ client, open, onToggle }: { client: LostClient; open: boolean; onToggle: () => void }) {
  // «Переходов», а не «отказов» — см. тот же комментарий в pages/LostClients.tsx.
  const refusalsLine = `${client.refusalCount} ${pluralizeRu(client.refusalCount, [
    "переход",
    "перехода",
    "переходов",
  ])}`;
  const name = client.fullName.trim() || formatClientName(client);
  const detailsId = `mlost-${client.id}`;

  return (
    <>
      <div className="row">
        <span className={`av ${avatarToneClass(name)}`} aria-hidden="true">
          {avatarInitial(name)}
        </span>
        <button
          type="button"
          className="t"
          style={{ textAlign: "left" }}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={onToggle}
        >
          <span className="n">
            <span className="nm">{name}</span>
            <span className="chip crit xs">{refusalsLine}</span>
          </span>
          {/* КОД И ТЕЛЕФОН — ВСЕГДА, а не вместо причины (22.09.2026). Было
              `lastReason ?? код · телефон`: как только у клиента появлялась
              причина отказа, номер с экрана пропадал, и позвонить с телефона
              было нельзя — только открыв карточку. На ПК (pages/LostClients.tsx)
              строка всегда полная: код · вид · телефон · причина. Здесь тот же
              порядок, вид опущен как на прежней узкой строке. */}
          <span className={client.lastReason ? "s warn" : "s"}>
            {formatClientCode(client.shortId, client.kind)} · {client.phone}
            {client.lastReason ? ` · ${client.lastReason}` : ""}
          </span>
        </button>
        <Link className="btn pill sm" to={`/clients/${client.shortId}`} onClick={(e) => e.stopPropagation()}>
          Открыть
        </Link>
        <span className="r" aria-hidden="true">
          {open ? <ChevronDown className="i" /> : <ChevronRight className="i" />}
        </span>
      </div>

      {open && (
        <div className="card-s" id={detailsId} style={{ margin: "0 14px 12px" }}>
          <div className="list compact">
            {client.chain.length === 0 ? (
              <div className="state">Записей о передачах нет.</div>
            ) : (
              client.chain.map((hop, i) => (
                <div className="row" key={i}>
                  <span className="b">
                    <span className="n">
                      <span className="nm">{hop.agentName}</span>
                    </span>
                    <span className="s">
                      <span className="tx">{hop.notes}</span>
                    </span>
                  </span>
                  <span className="r">
                    <span className="tm">{relativeTime(hop.at)}</span>
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>
  );
}
