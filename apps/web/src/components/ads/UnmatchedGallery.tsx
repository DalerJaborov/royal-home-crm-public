import { useState } from "react";
import { parseShortCode } from "@royal-home/shared";
import { Check, ExternalLink, Image as ImageIcon, Layers, Search } from "lucide-react";
import { useCanWriteAds, useLinkAd, useProperties } from "../../hooks/useAds";
import type { AdSheetTarget } from "./AdPropertiesSheet";
import type { UnmatchedAd } from "../../hooks/useAds";
import { formatMoneyExact } from "../../lib/format";

/**
 * ПРИВЯЗКА РЕКЛАМЫ К ОБЪЕКТАМ — галерея публикаций.
 *
 * На живых данных агентства автоматика не смогла привязать ничего: реклама идёт
 * на постах, ссылок на которые нет в карточках, а номера объекта в подписях не
 * пишут. Врать привязкой нельзя — значит нужно сделать ручную работу быстрой.
 *
 * Отсюда форма экрана: не список строк с выпадашкой, а КРУПНЫЕ КАРТОЧКИ —
 * превью публикации, её текст и деньги, которые она уже съела. Человек узнаёт
 * свой пост в лицо за секунду; текстом это заняло бы полминуты и ошибку через
 * раз. Кандидаты-объекты подсказаны по словам из подписи и жмутся одним
 * касанием; если подсказки мимо — поиск по номеру или адресу рядом.
 *
 * ОБЛИК — тема «Royal Home 2026»: карточка `.card.flat`, превью `.ph`, метки
 * `.chip`, кандидаты — строки `.prow` с действием `.pill`, поиск — `.inp`.
 */
export function UnmatchedGallery({
  items,
  onEditProperties,
}: {
  items: UnmatchedAd[];
  /** Окно «Привязать объекты» — для объявления, где в одном посте несколько квартир. */
  onEditProperties: (target: AdSheetTarget) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="empty">
        <span className="ic">
          <Check className="i" aria-hidden />
        </span>
        <p>Всё привязано к объектам.</p>
      </div>
    );
  }

  return (
    <div className="chn-grid" style={{ marginTop: 12 }}>
      {items.map((ad) => (
        <AdCard key={ad.id} ad={ad} onEditProperties={onEditProperties} />
      ))}
    </div>
  );
}

function AdCard({ ad, onEditProperties }: { ad: UnmatchedAd; onEditProperties: (target: AdSheetTarget) => void }) {
  const link = useLinkAd();
  const canEdit = useCanWriteAds();
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState("");
  const { data: found, isFetching: searchingNow } = useProperties(query, searching && (query.trim().length > 1 || parseShortCode(query) !== null));
  const [linkedTo, setLinkedTo] = useState<string | null>(null);

  const attach = async (propertyId: string, label: string) => {
    await link.mutateAsync({ id: ad.id, propertyId });
    setLinkedTo(label);
  };

  if (linkedTo) {
    return (
      <div className="card flat">
        <div className="quiet">
          <span className="dot ok" />
          <span className="txt">Привязано к {linkedTo}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="card flat">
      <div className="prow wrapt" style={{ borderBottom: 0 }}>
        {/* Превью публикации — то, по чему пост узнают в лицо. */}
        <span className="ph" aria-hidden>
          {ad.previewUrl ? <img src={ad.previewUrl} alt="" loading="lazy" /> : <ImageIcon className="i" />}
        </span>

        <div className="t">
          <b>{ad.campaignName ?? ad.name}</b>
          <span>
            {ad.caption?.replace(/\s+/g, " ").trim() || "Подписи нет — публикации не оказалось в нашей ленте."}
          </span>
          <span>
            {formatMoneyExact(ad.spendOriginal, ad.currency)} · {ad.conversations} обращ. ·{" "}
            {ad.impressions.toLocaleString("ru-RU")} показов
            {ad.postUrl && (
              <>
                {" · "}
                <a className="lk" href={ad.postUrl} target="_blank" rel="noreferrer">
                  открыть <ExternalLink className="i" aria-hidden />
                </a>
              </>
            )}
          </span>
        </div>

        {ad.isOurPost && <span className="chip">наша публикация</span>}
      </div>

      {/* Кандидаты: подсказка по словам из подписи. Решает всегда человек. */}
      <div className="list">
        {ad.candidates.length > 0 ? (
          ad.candidates.map((c) => (
            <div className="prow" key={c.id}>
              <span className="ph" aria-hidden>
                {c.coverUrl ? <img src={c.coverUrl} alt="" loading="lazy" /> : <ImageIcon className="i" />}
              </span>
              <div className="t">
                <b>
                  №{c.shortId} · {c.title}
                </b>
                <span>{c.address}</span>
              </div>
              <div className="act">
                <button
                  className="pill ghost sm"
                  type="button"
                  onClick={() => attach(c.id, `№${c.shortId}`)}
                  disabled={link.isPending}
                >
                  Привязать
                </button>
              </div>
            </div>
          ))
        ) : (
          <p className="state">Подсказок нет — найдите объект вручную.</p>
        )}
      </div>

      {/* Объявление про несколько квартир: один объект тут не подходит — доли
          делятся между всеми. Окно собирает их разом. */}
      {canEdit && (
        <button
          className="lnk"
          type="button"
          style={{ display: "block", marginBottom: 8 }}
          onClick={() =>
            onEditProperties({
              id: ad.id,
              title: ad.campaignName ?? ad.name,
              assetCount: null,
              properties: [],
              candidates: ad.candidates,
            })
          }
        >
          <Layers className="i" aria-hidden /> привязать несколько объектов
        </button>
      )}

      {searching ? (
        <div style={{ marginTop: 8 }}>
          <input
            className="inp"
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Номер объекта или адрес"
            style={{ width: "100%" }}
          />
          <div className="list">
            {(found ?? []).slice(0, 5).map((p) => (
              <div className="prow" key={p.id}>
                <div className="t">
                  <b>
                    №{p.shortId} · {p.title}
                  </b>
                </div>
                <div className="act">
                  {/* Пока идёт поиск, список — от прошлого запроса: привязать можно не тот. */}
                  <button
                    className="pill ghost sm"
                    type="button"
                    onClick={() => attach(p.id, `№${p.shortId}`)}
                    disabled={link.isPending || searchingNow}
                  >
                    Привязать
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <button className="lnk" type="button" onClick={() => setSearching(true)}>
          <Search className="i" aria-hidden /> найти объект вручную
        </button>
      )}
    </div>
  );
}
