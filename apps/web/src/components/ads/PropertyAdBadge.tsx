import { Link } from "react-router-dom";
import { usePropertyAds } from "../../hooks/useAds";
import { formatMoneyExact, pluralizeRu } from "../../lib/format";
import { describeLeadStats, formatLeadCount, formatPct } from "../../lib/adsView";
import { AdLeadStatsLine } from "./AdLeadStatsLine";

/**
 * «ЭТОТ ОБЪЕКТ В ПРОДВИЖЕНИИ» — плашка в карточке объекта.
 *
 * ⚠️ «Сейчас в продвижении» приходит с сервера по ФАКТУ ТРАТ, а не по статусу
 * Meta: у неё завершённое объявление навсегда остаётся ACTIVE, и до 03.09.2026
 * зелёная точка горела на квартирах, рекламу которых выключили ещё весной
 * (api: lib/ads/adDelivery.ts).
 *
 * Просьба владельца 21.08.2026: агент или директор открывает квартиру и должен
 * сразу видеть, крутится ли по ней реклама и что она дала. Раньше за этим надо
 * было идти в отдельный раздел и искать объект глазами.
 *
 * Показываем ровно четыре числа — потрачено, показы, переписки, цена переписки, —
 * и ничего больше: карточка объекта не место для рекламной аналитики, для неё
 * есть свой раздел, и ссылка туда рядом.
 *
 * Если реклама по объекту никогда не шла, блок не рисуется вовсе: пустая плашка
 * «рекламы нет» на каждой карточке — шум, который перестают замечать.
 */
export function PropertyAdBadge({ propertyId }: { propertyId: string }) {
  const { data } = usePropertyAds(propertyId);
  if (!data || data.ads === 0) return null;

  const sharedAds = (data.adsOfProperty ?? [])
    .filter((a): a is typeof a & { objectsInAd: number } => (a.objectsInAd ?? 1) > 1)
    .slice(0, 5);
  const leadText = describeLeadStats(data.leadStats, data.spendTjs ?? 0);
  const perConversation =
    data.conversations && data.conversations > 0 && data.spendTjs ? data.spendTjs / data.conversations : null;

  return (
    /* Карточка эталона: заголовок `.sec-h` со сводкой справа, цифры рядом
       `.trio`, служебная строка снизу `.quiet`. Пульсирующей точки нет:
       бесконечных анимаций договор дизайна не допускает (§6.4). */
    <div className="card">
      <div className="sec-h stack">
        <h2>{data.promoting ? "Сейчас в продвижении" : "Продвигался раньше"}</h2>
        <Link className="lnk" to="/ads">
          Вся реклама
        </Link>
      </div>
      {/* Четыре цифры — плитки `.tiles` эталона: на телефоне они сами встают
          в две колонки, а `.trio` из трёх ячеек четвёртую выдавливала за край. */}
      <div className="tiles">
        <Stat label="Потрачено" value={formatMoneyExact(data.spendTjs ?? 0, "TJS")} />
        <Stat label="Показов" value={(data.impressions ?? 0).toLocaleString("ru-RU")} />
        <Stat label="Обращений" value={String(data.conversations ?? 0)} />
        <Stat
          label="За обращение"
          value={perConversation !== null ? formatMoneyExact(perConversation, "TJS") : "нет данных"}
        />
        {/* Реальная цена (волна 1): клиенты, попавшие в CRM с рекламы объекта. Плитки
            появляются, только когда сервер прислал поле и есть о чём сказать. */}
        {leadText && (
          <>
            {/* Клиенты общих объявлений делятся между объектами (0,5 клиента), поэтому дробь подписываем словами. */}
            <Stat
              label={Number.isInteger(data.leadStats?.leads ?? 0) ? "Клиентов в CRM" : "Клиентов в CRM (доля)"}
              value={formatLeadCount(data.leadStats?.leads ?? 0)}
            />
            <Stat
              label="Цена клиента"
              value={
                data.leadStats?.costPerLeadTjs != null
                  ? formatMoneyExact(data.leadStats.costPerLeadTjs, "TJS")
                  : "клиентов в CRM нет"
              }
            />
          </>
        )}
      </div>
      {/* Подсказка и воронка: обращение Meta ≠ клиент CRM; дальше — показы, сделки, комиссия. */}
      {/* Клиенты и их цена уже стоят плитками выше - строка повторяет только то, чего в плитках нет (воронку). */}
      <AdLeadStatsLine stats={data.leadStats} spendTjs={data.spendTjs ?? 0} compact funnelOnly={Boolean(leadText)} />
      {/* ОБЩИЕ ОБЪЯВЛЕНИЯ (03.10.2026): одно объявление может нести несколько
          квартир, и деньги выше — уже ДОЛЯ этого объекта, а не весь расход.
          Строка появляется только когда сервер прислал доли и объектов больше
          одного: пока поля нет, плашка выглядит как раньше. */}
      {sharedAds.map((a) => (
        <div className="quiet" key={a.adId}>
          <span className="dot" />
          <span className="txt">
            {a.name ? `«${a.name}»: ` : ""}входит в объявление на {a.objectsInAd}{" "}
            {pluralizeRu(a.objectsInAd, ["объект", "объекта", "объектов"])}, доля {formatPct(a.share * 100)}
            {a.spendTjs != null && <>, на этот объект {formatMoneyExact(a.spendTjs, "TJS")}</>}
          </span>
        </div>
      ))}
      <div className="quiet">
        <span className={data.promoting ? "dot ok" : "dot"} />
        <span className="txt">
          {data.ads} объявл.
          {data.firstSpendAt &&
            ` · с ${new Date(data.firstSpendAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "short" })}`}
          {!data.promoting &&
            data.lastSpendAt &&
            ` · последняя трата ${new Date(data.lastSpendAt).toLocaleDateString("ru-RU", { timeZone: "Asia/Dushanbe", day: "numeric", month: "short" })}`}
        </span>
        {data.postUrl && (
          <a className="lnk" href={data.postUrl} target="_blank" rel="noreferrer">
            Публикация
          </a>
        )}
      </div>
    </div>
  );
}

/** Одна цифра рекламы: плитка `.tile` эталона (подпись сверху, число снизу). */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="tile">
      <div className="hd">{label}</div>
      <b style={{ fontSize: "var(--fs-23)" }}>{value}</b>
    </div>
  );
}
