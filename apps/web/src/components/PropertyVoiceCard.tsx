import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Info, OctagonAlert } from "lucide-react";
import {
  PROPERTY_VOICE_PRICE_REACTION_DAYS,
  pluralizeRu,
  type PropertyDiagnosis,
  type PropertyDiagnosisSeverity,
  type PropertyVoiceResponse,
} from "@royal-home/shared";
import { api } from "../lib/api";
import { dushanbeDate } from "../lib/date";
import { formatMoney } from "../lib/format";
import { channelMeta } from "../lib/channelMeta";
import {
  buildVoiceFunnel,
  buildVoiceTopics,
  costPerInquiry,
  dealStageLabel,
  daysSinceText,
  DIAGNOSIS_SEVERITY_WORD,
  priceReaction,
  sharePercent,
  signedPercent,
  VOICE_TOPIC_SOURCE_LABEL,
  weekLabel,
  weeklyBars,
} from "../lib/propertyVoiceView";

/**
 * ВКЛАДКА «ГОЛОС РЫНКА» КАРТОЧКИ ОБЪЕКТА (03.10.2026).
 *
 * Что говорят про этот объект — в комментариях, на звонках, у собственника, на
 * показах — и честный диагноз «почему он не продаётся». Один адаптивный компонент
 * на телефон и компьютер (правило CLAUDE.md): отдельной мобильной копии нет, узкий
 * вид делают медиа-правила темы (`.pvc-*` в theme-2026-dashboard.css).
 *
 * Сам ничего не считает: диагноз, воронку и тексты собирает сервер
 * (GET /properties/:id/voice, lib/propertyVoice/). Тексты клиентов приходят с
 * закрытыми телефонами. Блок «после показа» рисуется ТОЛЬКО если сервер его
 * прислал: у кого нет права, ключа в ответе нет, и это «не положено», а не «пусто».
 */

const num = (n: number) => n.toLocaleString("ru-RU");

const SEVERITY_ICON: Record<PropertyDiagnosisSeverity, typeof Info> = {
  bad: OctagonAlert,
  warn: AlertTriangle,
  info: Info,
};

export function usePropertyVoice(propertyId: string) {
  return useQuery({
    queryKey: ["property-voice", propertyId],
    queryFn: () => api<PropertyVoiceResponse>(`/properties/${propertyId}/voice`),
    staleTime: 5 * 60_000,
  });
}

const TOPICS_COLLAPSED = 8;

/**
 * Телефон: вкладок нет, секции карточки идут стопкой. «Голос рынка» длинный, поэтому
 * здесь он свёрнут и запрос уходит только после раскрытия.
 */
export function PropertyVoiceDisclosure({ propertyId }: { propertyId: string }) {
  const [opened, setOpened] = useState(false);
  return (
    <details className="card pvc-disclosure" onToggle={(e) => setOpened(e.currentTarget.open)}>
      <summary>
        <span className="sec-h stack">
          <h2>Голос рынка и диагноз</h2>
          <span className="note">что говорят про объект и почему он не продаётся</span>
        </span>
      </summary>
      {opened && <PropertyVoiceCard propertyId={propertyId} />}
    </details>
  );
}

export function PropertyVoiceCard({ propertyId }: { propertyId: string }) {
  const voice = usePropertyVoice(propertyId);

  if (voice.isLoading) {
    return (
      <section className="card" aria-busy="true">
        <div className="state">
          <span className="sk w40" /> Собираем голос рынка по объекту
        </div>
      </section>
    );
  }
  if (voice.error || !voice.data) {
    return (
      <section className="card">
        <p className="state" role="alert">
          Голос рынка сейчас собрать не получилось.{" "}
          <button type="button" className="pill ghost" onClick={() => void voice.refetch()}>
            Повторить
          </button>
        </p>
      </section>
    );
  }
  const v = voice.data;
  return (
    <div className="pst pvc">
      <DiagnosisSection items={v.diagnosis} />
      <InterestSection v={v} />
      <QuestionsSection v={v} />
      <BargainingSection v={v} />
      <AdsSection v={v} />
      {v.showingFeedback && <FeedbackSection feedback={v.showingFeedback} />}
    </div>
  );
}

// ─── Диагноз ───────────────────────────────────────────────────────────────

function DiagnosisSection({ items }: { items: PropertyDiagnosis[] }) {
  return (
    <section className="card" aria-labelledby="pvc-diag-h">
      <div className="sec-h stack">
        <h2 id="pvc-diag-h">Диагноз</h2>
        <span className="note">подсказка по цифрам, а не приговор</span>
      </div>
      {items.length === 0 ? (
        <div className="empty">
          <p>По цифрам явных причин не нашли.</p>
          <p className="sub">Это не значит, что причин нет, — только что данные на них не указывают.</p>
        </div>
      ) : (
        <ul className="pvc-diag">
          {items.map((d) => {
            const Icon = SEVERITY_ICON[d.severity];
            return (
              <li key={d.code} className={`pvc-d ${d.severity}`}>
                <div className="pvc-d-head">
                  <span className="pvc-sev">
                    <Icon className="i" aria-hidden /> {DIAGNOSIS_SEVERITY_WORD[d.severity]}
                  </span>
                  <h3>{d.title}</h3>
                </div>
                <p>{d.text}</p>
                {d.evidence.length > 0 && (
                  <details className="pvc-ev">
                    <summary>Цифры, на которых это основано</summary>
                    <ul>
                      {d.evidence.map((e, i) => (
                        <li key={`${i}-${e}`}>{e}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ─── Воронка интереса ──────────────────────────────────────────────────────

function InterestSection({ v }: { v: PropertyVoiceResponse }) {
  const steps = buildVoiceFunnel(v);
  const { bars, total, peak } = weeklyBars(v.interest.weekly);
  const ex = v.interest.exposures;
  const sharedPct = sharePercent(ex.clientSharedShare);
  return (
    <section className="card" aria-labelledby="pvc-int-h">
      <div className="sec-h stack">
        <h2 id="pvc-int-h">Воронка интереса</h2>
        <span className="note">за {v.windowDays} дн.; сделки — за всё время</span>
      </div>

      <ol className="pvc-funnel">
        {steps.map((s) => (
          <li key={s.key}>
            <div className="pvc-f-top">
              <b>{s.label}</b>
              <span>
                <b className="n">{num(s.count)}</b>
                {s.people != null && (
                  <>
                    {" · "}
                    {num(s.people)} {pluralizeRu(s.people, ["человек", "человека", "человек"])}
                  </>
                )}
              </span>
            </div>
            <span className="pvc-bar" aria-hidden>
              <span style={{ width: `${s.barPct}%` }} />
            </span>
            {s.shareOfPrev != null && <span className="pvc-hint">дошли {s.shareOfPrev}% от прошлого шага</span>}
          </li>
        ))}
      </ol>

      <div className="pvc-facts">
        <span>
          Клиент сам прислал объект:{" "}
          <b>{sharedPct ? `${sharedPct} (${num(ex.clientShared)} из ${num(ex.total)})` : "объект людям не отправляли"}</b>
        </span>
        <span>
          Последний интерес: <b>{daysSinceText(v.interest.daysSinceLastEvent)}</b>
        </span>
        <span>
          Диалогов бота про объект: <b>{num(v.interest.conversations.total)}</b>
        </span>
      </div>

      <h3 className="sec-t">По неделям</h3>
      {total === 0 ? (
        <p className="quiet">За последние {bars.length} недель событий интереса не было.</p>
      ) : (
        <div className="pvc-weekly">
          <svg
            viewBox={`0 0 ${bars.length * 16 - 4} 64`}
            role="img"
            aria-label={`События интереса по неделям за последние ${bars.length}: всего ${total}, больше всего за неделю ${peak}`}
          >
            {bars.map((b, i) => {
              const h = Math.round((b.heightPct / 100) * 60);
              const x = i * 16;
              return (
                <g key={b.weekStart}>
                  <title>{`С ${weekLabel(b.weekStart)}: ${b.events} событий, ${b.people} человек`}</title>
                  <rect x={x} y={0} width={12} height={60} rx={3} className="track" />
                  {h > 0 && <rect x={x} y={60 - h} width={12} height={h} rx={3} className="fill" />}
                </g>
              );
            })}
          </svg>
          <div className="pvc-weekly-cap">
            <span>с {weekLabel(bars[0].weekStart)}</span>
            <span>
              всего {num(total)}, пик за неделю {num(peak)}
            </span>
            <span>эта неделя</span>
          </div>
        </div>
      )}
    </section>
  );
}

// ─── Что спрашивают и возражают ────────────────────────────────────────────

function QuestionsSection({ v }: { v: PropertyVoiceResponse }) {
  const [all, setAll] = useState(false);
  const topics = buildVoiceTopics(v);
  const shown = all ? topics : topics.slice(0, TOPICS_COLLAPSED);
  const q = v.questions;
  return (
    <section className="card" aria-labelledby="pvc-q-h">
      <div className="sec-h stack">
        <h2 id="pvc-q-h">Что спрашивают и возражают</h2>
        <span className="note">за {v.windowDays} дн.</span>
      </div>

      <div className="pvc-facts">
        <span>
          Комментариев: <b>{num(q.comments.total)}</b>, передано человеку: <b>{num(q.comments.escalated.count)}</b>
        </span>
        <span>
          Вопросов собственнику: <b>{num(q.ownerQuestions.total)}</b>, с ответом: <b>{num(q.ownerQuestions.answered)}</b>
        </span>
        <span>
          Звонков с возражениями: <b>{num(q.callObjections.calls)}</b>
        </span>
        <span>
          Показов: <b>{num(q.showings.total)}</b>, проведено: <b>{num(q.showings.conducted)}</b>, отказов клиентов после показа:{" "}
          <b>{num(q.refusals.total)}</b>
        </span>
      </div>

      {q.comments.byChannel.length > 0 && (
        <div className="pvc-chips" aria-label="Комментарии по каналам">
          {q.comments.byChannel.map((c) => (
            <span className="chip mute" key={c.channel}>
              {channelMeta(c.channel).label}: <b>{num(c.count)}</b>
            </span>
          ))}
        </div>
      )}

      {topics.length === 0 ? (
        <div className="empty">
          <p>Частых вопросов и возражений по объекту пока нет.</p>
          <p className="sub">Тексты появятся, когда под объектом начнут писать и звонить.</p>
        </div>
      ) : (
        <>
          <div className="list pvc-topics">
            {shown.map((t) => (
              <div className="row" key={t.id}>
                <div className="t">
                  <b>«{t.text}»</b>
                  <span>
                    {VOICE_TOPIC_SOURCE_LABEL[t.source]}
                    {t.price ? " · про цену" : ""}
                  </span>
                </div>
                <span className={`chip ${t.price ? "warn" : "mute"}`} aria-label={`Повторилось ${t.count} раз`}>
                  ×{num(t.count)}
                </span>
              </div>
            ))}
          </div>
          {topics.length > TOPICS_COLLAPSED && (
            <button type="button" className="pill ghost" aria-expanded={all} onClick={() => setAll((x) => !x)}>
              {all ? "Свернуть" : `Показать все (${topics.length})`}
            </button>
          )}
        </>
      )}

      {q.refusals.byReason.length > 0 && (
        <>
          <h3 className="sec-t">Почему отказываются после показа</h3>
          <div className="pvc-chips">
            {q.refusals.byReason.map((r) => (
              <span className="chip mute" key={r.key}>
                {r.label ?? r.key}: <b>{num(r.count)}</b>
              </span>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

// ─── Торг ──────────────────────────────────────────────────────────────────

function BargainingSection({ v }: { v: PropertyVoiceResponse }) {
  const { priceChanges, deals, dealsOwnOnly } = v.bargaining;
  return (
    <section className="card" aria-labelledby="pvc-b-h">
      <div className="sec-h stack">
        <h2 id="pvc-b-h">Торг</h2>
        <span className="note">изменения цены и что стало с интересом</span>
      </div>
      {dealsOwnOnly && (
        <p className="quiet">Сделки: показаны только ваши, чужие по этому объекту скрыты правами.</p>
      )}
      {priceChanges.length === 0 && deals.length === 0 ? (
        <div className="empty">
          <p>Цену не меняли, сделок с ценой продажи нет.</p>
        </div>
      ) : (
        <div className="list">
          {priceChanges.map((c) => {
            const reaction = priceReaction(c, PROPERTY_VOICE_PRICE_REACTION_DAYS);
            const delta = signedPercent(c.deltaPct);
            return (
              <div className="row" key={c.at}>
                <div className="t">
                  <b>
                    {formatMoney(c.oldPrice, c.oldCurrency)} → {formatMoney(c.newPrice, c.newCurrency)}
                    {delta ? ` (${delta})` : ""}
                  </b>
                  <span>
                    {dushanbeDate(c.at)} · {reaction.text}
                  </span>
                </div>
                <span className={`chip pvc-react ${reaction.tone}`}>{REACTION_WORD[reaction.tone]}</span>
              </div>
            );
          })}
          {deals.map((d, i) => (
            <div className="row" key={`${i}-${d.stage}-${d.closedAt ?? ""}`}>
              <div className="t">
                <b>
                  Сделка: {dealStageLabel(d.stage)}{" "}
                  {d.soldPrice != null ? formatMoney(d.soldPrice, d.currency) : "скрыта правами"}
                </b>
                <span>
                  цена в карточке {formatMoney(d.listPrice, d.listCurrency)}
                  {d.discountPct != null && d.discountPct !== 0
                    ? ` · ${d.discountPct < 0 ? "ниже" : "выше"} на ${Math.abs(d.discountPct).toString().replace(".", ",")}%`
                    : d.discountPct === 0
                      ? " · без уступки"
                      : ""}
                  {d.closedAt ? ` · закрыта ${dushanbeDate(d.closedAt)}` : ""}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

const REACTION_WORD = {
  unknown: "нет данных",
  pending: "копится",
  up: "вырос",
  flat: "без изменений",
  down: "упал",
} as const;

// ─── Реклама ───────────────────────────────────────────────────────────────

function AdsSection({ v }: { v: PropertyVoiceResponse }) {
  const ads = v.ads;
  const cpl = costPerInquiry(ads);
  const money = (n: number) => `${num(Math.round(n))} сомони`;
  return (
    <section className="card" aria-labelledby="pvc-a-h">
      <div className="sec-h stack">
        <h2 id="pvc-a-h">Реклама на объект</h2>
        <span className="note">за всё время</span>
      </div>
      {ads.adsCount === 0 || (!ads.moneyHidden && ads.spendTjs == null) ? (
        <div className="empty">
          <p>Реклама по этому объекту не шла.</p>
        </div>
      ) : (
        <>
          <dl className="pvc-stats">
            {ads.spendTjs != null && (
              <div>
                <dt>Расход</dt>
                <dd>{money(ads.spendTjs)}</dd>
              </div>
            )}
            <div>
              <dt>Показов</dt>
              <dd>{num(ads.impressions)}</dd>
            </div>
            <div>
              <dt>Кликов</dt>
              <dd>{num(ads.clicks)}</dd>
            </div>
            <div>
              <dt>Обращений</dt>
              <dd>{num(Math.max(ads.conversations, ads.botConversations))}</dd>
            </div>
            {!ads.moneyHidden && (
              <div>
                <dt>Цена обращения</dt>
                <dd>{cpl ? money(cpl.value) : "—"}</dd>
              </div>
            )}
          </dl>
          {ads.moneyHidden && (
            <p className="quiet">Суммы рекламы скрыты правами: расход и цена обращения видны тем, у кого есть доступ к финансам или маркетингу.</p>
          )}
          <p className="quiet">
            {ads.moneyHidden
              ? "Обращения — начатые переписки по данным рекламной системы или диалоги бота, начатые из этой рекламы."
              : cpl
              ? cpl.basis === "ads"
                ? "Обращения — начатые переписки по данным рекламной системы."
                : "Рекламная система не отдала переписки: обращения — диалоги бота, начатые из этой рекламы."
              : "Обращений нет, поэтому цену обращения не считаем."}
            {ads.adsCount > 0 ? ` Объявлений: ${ads.adsCount}.` : ""}
          </p>
        </>
      )}
    </section>
  );
}

// ─── Голос клиентов после показа (только если сервер прислал) ──────────────

function FeedbackSection({ feedback }: { feedback: NonNullable<PropertyVoiceResponse["showingFeedback"]> }) {
  return (
    <section className="card" aria-labelledby="pvc-f-h">
      <div className="sec-h stack">
        <h2 id="pvc-f-h">Голос клиентов после показа</h2>
        <span className="note">звонки-опросы · видно руководителям</span>
      </div>
      {feedback.calls === 0 ? (
        <div className="empty">
          <p>После показов этого объекта опросов пока не было.</p>
        </div>
      ) : (
        <>
          <p className="quiet">
            Опросов: <b>{num(feedback.calls)}</b>
          </p>
          {feedback.byOutcome.length > 0 && (
            <div className="pvc-chips">
              {feedback.byOutcome.map((o) => (
                <span className="chip mute" key={o.key}>
                  {o.label ?? o.key}: <b>{num(o.count)}</b>
                </span>
              ))}
            </div>
          )}
          {feedback.redFlags.length > 0 && (
            <>
              <h3 className="sec-t">Что насторожило покупателей</h3>
              <div className="list">
                {feedback.redFlags.map((f, i) => (
                  <div className="row" key={`${i}-${f.text}`}>
                    <div className="t">
                      <b>{f.text}</b>
                    </div>
                    <span className="chip mute">×{num(f.count)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
          {feedback.quotes.length > 0 && (
            <>
              <h3 className="sec-t">Что говорят</h3>
              <ul className="pvc-quotes">
                {feedback.quotes.map((q, i) => (
                  <li key={`${i}-${q}`}>«{q}»</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
