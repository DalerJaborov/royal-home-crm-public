import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Star, Power, Instagram, MessageCircle, MessageSquareText, KeyRound, Tag } from "lucide-react";
import { api } from "../../lib/api";
import { InstagramAppBinding } from "./InstagramAppBinding";

/**
 * Подключённые аккаунты Instagram (и других каналов Meta).
 *
 * ЗАЧЕМ ЭКРАН. Раньше маркер был один и лежал полем ниже — это означало ровно
 * один аккаунт на канал. Агентству понадобился второй Instagram (Royal Home
 * Info: советы, чек-листы, вакансии), и подключать его стало некуда. Здесь их
 * список: добавить, выключить, назначить основным.
 *
 * ОСНОВНОЙ — это тот, кто отвечает на входящее от неизвестного получателя
 * (например, аккаунт подключили в Meta, но забыли завести здесь). Такой ответ
 * лучше тишины, но он один: два «основных» означали бы два разных ответа на
 * одинаковые обращения.
 *
 * СВОЙ ПРОМТ У АККАУНТА заменяет «личность» бота только в его переписках.
 * Обязательные правила (кем себя называть, запрет выдумывать объекты, география)
 * приклеиваются поверх всегда — их своим промтом не отменить.
 *
 * ИМЯ КОМПАНИИ У АККАУНТА (08.11.2026). Второй бренд на тех же фактах (дочерняя
 * компания) просит, чтобы бот называл компанию иначе: пусто — «Royal Home», как везде.
 *
 * ВТОРОЙ НОМЕР WHATSAPP (12.11.2026). Дочерней компании («Арван») нужен свой номер
 * WhatsApp рядом с основным. Основной вписан в Настройках (поля выше), а здесь заводятся
 * дополнительные: у каждого свой идентификатор номера, свой маркер и своё имя компании.
 * Сервер сам проверяет маркер и номер у Meta и не принимает маркер, уже занятый другим
 * номером (messengers/accounts.ts::findTokenCollision).
 *
 * Разметка — эталон темы «Royal Home 2026»: заголовок секции `.sec-h.stack`,
 * аккаунты — строки списка `.row`, форма подключения — поля `.fld`.
 */
interface AccountRow {
  id: string;
  channel: string;
  externalId: string;
  title: string;
  enabled: boolean;
  isDefault: boolean;
  hasToken: boolean;
  systemPrompt: string | null;
  brandName: string | null;
}

/** Какой канал сейчас подключают: пусто — форма закрыта. */
type AddingChannel = "INSTAGRAM" | "WHATSAPP" | null;

/** Идентификатор номера (Phone number ID) — только цифры; телефон с плюсом сюда не годится. */
export const PHONE_NUMBER_ID = /^\d{5,30}$/;

const CHANNEL_TITLES: Record<string, string> = {
  INSTAGRAM: "Instagram",
  FACEBOOK: "Facebook",
  WHATSAPP: "WhatsApp",
};

export function MessengerAccounts() {
  const queryClient = useQueryClient();
  const { data } = useQuery<{ items: AccountRow[] }>({
    queryKey: ["messenger-accounts"],
    queryFn: () => api("/settings/messenger-accounts"),
  });
  const items = data?.items ?? [];

  const [adding, setAdding] = useState<AddingChannel>(null);
  const [title, setTitle] = useState("");
  const [token, setToken] = useState("");
  /** Идентификатор номера WhatsApp (Phone number ID) — только в форме WhatsApp. */
  const [phoneId, setPhoneId] = useState("");
  /** Имя компании для нового аккаунта; пусто — «Royal Home». */
  const [brand, setBrand] = useState("");
  /** Какому аккаунту правят имя компании, и черновик до сохранения. */
  const [brandFor, setBrandFor] = useState<string | null>(null);
  const [draftBrand, setDraftBrand] = useState("");
  /** Какому аккаунту сейчас правят промт, и черновик текста до сохранения. */
  const [promptFor, setPromptFor] = useState<string | null>(null);
  const [draftPrompt, setDraftPrompt] = useState("");
  /**
   * Какому аккаунту меняют маркер. Замены здесь не было вовсе (найдено
   * 21.09.2026): сервер её умел с самого начала (POST с id и token), а в списке
   * стояли только промт, «сделать основным», выключить и удалить. Перевыпустив
   * маркер в кабинете Meta, вписать его было НЕКУДА — поле «Маркер Instagram»
   * ниже это запасной путь, и на аккаунт из этого списка оно не влияет вовсе
   * (messengers/meta.ts::loadCredentials берёт маркер основного аккаунта, а
   * поле Настроек — только если аккаунтов нет). Оставалось удалить аккаунт и
   * завести заново, потеряв его собственный промт.
   */
  const [tokenFor, setTokenFor] = useState<string | null>(null);
  const [draftToken, setDraftToken] = useState("");

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["messenger-accounts"] });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api("/settings/messenger-accounts", { method: "POST", body }),
    onSuccess: () => {
      refresh();
      setAdding(null);
      setTitle("");
      setToken("");
      setPhoneId("");
      setBrand("");
      setBrandFor(null);
      setPromptFor(null);
      setTokenFor(null);
      setDraftToken("");
    },
    // alert() убран (аудит 22.08.2026, раунд 6): блокирующее окно браузера —
    // единственное на весь аудированный интерфейс, и оно ещё и дублировалось
    // общим тостом об ошибке. Тост уже говорит то же самое и не запирает экран.
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/settings/messenger-accounts/${id}`, { method: "DELETE" }),
    // Отключение аккаунта отвечало «Сохранено» — неверный глагол.
    meta: { successText: "Аккаунт отключён" },
    onSuccess: refresh,
  });

  return (
    <div style={{ marginTop: "var(--s4)" }}>
      <div className="sec-h stack">
        <h2>Аккаунты Instagram и номера WhatsApp</h2>
        <span className="note">
          Можно подключить несколько: основной для продаж и, например, информационный или номер дочерней
          компании. Каждый отвечает от своего имени, переписка не смешивается. Основной номер WhatsApp
          вписан в полях выше, здесь добавляются дополнительные
        </span>
      </div>
      <div className="wrap">
        <button
          className="pill ghost sm"
          type="button"
          onClick={() => setAdding((v) => (v === "INSTAGRAM" ? null : "INSTAGRAM"))}
        >
          Добавить Instagram
        </button>
        <button
          className="pill ghost sm"
          type="button"
          onClick={() => setAdding((v) => (v === "WHATSAPP" ? null : "WHATSAPP"))}
        >
          Добавить номер WhatsApp
        </button>
      </div>

      {items.length > 0 && (
        <div className="list" style={{ marginTop: "var(--s3)" }}>
          {items.map((a) => (
            <div key={a.id}>
              <div className="row">
                {a.channel === "WHATSAPP" ? (
                  <MessageCircle className="i lg" aria-hidden="true" style={{ opacity: a.enabled ? 1 : 0.45 }} />
                ) : (
                  <Instagram className="i lg" aria-hidden="true" style={{ opacity: a.enabled ? 1 : 0.45 }} />
                )}
                <div className="t">
                  <b style={{ display: "flex", alignItems: "center", gap: "var(--s2)", flexWrap: "wrap" }}>
                    <span style={{ opacity: a.enabled ? 1 : 0.55 }}>{a.title}</span>
                    {a.isDefault && a.channel !== "WHATSAPP" && <span className="chip">основной</span>}
                    {!a.hasToken && <span className="chip crit">нет маркера</span>}
                    {a.systemPrompt && <span className="chip ok">свой промт</span>}
                    {a.brandName && <span className="chip ok">зовётся «{a.brandName}»</span>}
                  </b>
                  <span>
                    {CHANNEL_TITLES[a.channel] ?? a.channel} · {a.channel === "WHATSAPP" ? "номер " : ""}
                    {a.externalId}
                  </span>
                </div>
                <div className="act">
                  <button
                    className="pill ghost sm"
                    type="button"
                    title={
                      a.systemPrompt
                        ? "Свой промт этого аккаунта"
                        : "Задать свой промт: аккаунт будет говорить по-своему"
                    }
                    aria-label="Свой промт аккаунта"
                    onClick={() => {
                      const opening = promptFor !== a.id;
                      setPromptFor(opening ? a.id : null);
                      if (opening) setDraftPrompt(a.systemPrompt ?? "");
                    }}
                  >
                    <MessageSquareText className="i" aria-hidden="true" />
                  </button>

                  <button
                    className="pill ghost sm"
                    type="button"
                    title={
                      a.brandName
                        ? `Бот называет компанию «${a.brandName}»`
                        : "Как бот называет компанию: если не Royal Home, впишите своё имя"
                    }
                    aria-label="Как бот называет компанию"
                    onClick={() => {
                      const opening = brandFor !== a.id;
                      setBrandFor(opening ? a.id : null);
                      if (opening) setDraftBrand(a.brandName ?? "");
                    }}
                  >
                    <Tag className="i" aria-hidden="true" />
                  </button>

                  {!a.isDefault && a.channel !== "WHATSAPP" && (
                    <button
                      className="pill ghost sm"
                      type="button"
                      title="Сделать основным: он отвечает, когда получатель не опознан"
                      aria-label="Сделать основным"
                      onClick={() =>
                        save.mutate({
                          id: a.id,
                          channel: a.channel,
                          externalId: a.externalId,
                          title: a.title,
                          isDefault: true,
                        })
                      }
                    >
                      <Star className="i" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    className="pill ghost sm"
                    type="button"
                    title="Заменить маркер: после перевыпуска в кабинете Meta"
                    aria-label="Заменить маркер аккаунта"
                    onClick={() => {
                      const opening = tokenFor !== a.id;
                      setTokenFor(opening ? a.id : null);
                      if (opening) setDraftToken("");
                    }}
                  >
                    <KeyRound className="i" aria-hidden="true" />
                  </button>
                  <button
                    className="pill ghost sm"
                    type="button"
                    title={a.enabled ? "Выключить: перестанет принимать и отвечать" : "Включить"}
                    aria-label={a.enabled ? "Выключить аккаунт" : "Включить аккаунт"}
                    onClick={() =>
                      save.mutate({
                        id: a.id,
                        channel: a.channel,
                        externalId: a.externalId,
                        title: a.title,
                        enabled: !a.enabled,
                      })
                    }
                  >
                    <Power className="i" aria-hidden="true" />
                  </button>
                  <button
                    className="pill ghost sm"
                    type="button"
                    title="Удалить аккаунт (переписка сохранится)"
                    aria-label="Отключить аккаунт"
                    onClick={() => {
                      if (
                        confirm(
                          `Отключить аккаунт «${a.title}»? Переписка сохранится, но новые сообщения приходить перестанут.`
                        )
                      ) {
                        remove.mutate(a.id);
                      }
                    }}
                  >
                    <Trash2 className="i" aria-hidden="true" />
                  </button>
                </div>
              </div>

              {a.channel === "INSTAGRAM" && <InstagramAppBinding accountId={a.id} />}
              {tokenFor === a.id && (
                <div style={{ padding: "var(--s3) var(--s2) var(--s4)" }}>
                  <div className="quiet">
                    <span className="dot" />
                    <span className="txt">
                      Новый маркер заменит прежний: старое значение стирается и восстановить его отсюда
                      нельзя. Сам аккаунт, переписка и его промт останутся. CRM сверит маркер с Meta и не
                      примет нерабочий, так что публикация и ответы не остановятся от неудачной попытки.
                    </span>
                  </div>
                  <label className="fld" style={{ marginTop: "var(--s3)" }}>
                    <span className="lab">Новый маркер доступа</span>
                    <input
                      value={draftToken}
                      onChange={(e) => setDraftToken(e.target.value)}
                      placeholder={a.channel === "WHATSAPP" ? "EAA…" : "IGAA…"}
                    />
                  </label>
                  <div className="wrap" style={{ marginTop: "var(--s3)" }}>
                    <button
                      className="pill"
                      type="button"
                      disabled={save.isPending || !draftToken.trim()}
                      onClick={() =>
                        save.mutate({ id: a.id, channel: a.channel, title: a.title, token: draftToken.trim() })
                      }
                    >
                      {save.isPending ? "Проверяю у Meta…" : "Заменить маркер"}
                    </button>
                    <button className="pill ghost" type="button" onClick={() => setTokenFor(null)}>
                      Отмена
                    </button>
                  </div>
                </div>
              )}

              {brandFor === a.id && (
                <div style={{ padding: "var(--s3) var(--s2) var(--s4)" }}>
                  <div className="quiet">
                    <span className="dot" />
                    <span className="txt">
                      Так бот назовёт компанию в переписке и комментариях этого аккаунта. Все остальные
                      факты (город, офис, телефон, условия) остаются теми же. Пусто — бот говорит «Royal Home».
                    </span>
                  </div>
                  <label className="fld" style={{ marginTop: "var(--s3)" }}>
                    <span className="lab">Как бот называет компанию (если не Royal Home)</span>
                    <input
                      value={draftBrand}
                      maxLength={20}
                      onChange={(e) => setDraftBrand(e.target.value)}
                      placeholder="Арван"
                    />
                  </label>
                  <div className="wrap" style={{ marginTop: "var(--s3)" }}>
                    <button
                      className="pill"
                      type="button"
                      disabled={save.isPending || draftBrand.trim() === (a.brandName ?? "")}
                      onClick={() =>
                        save.mutate({ id: a.id, channel: a.channel, title: a.title, brandName: draftBrand.trim() })
                      }
                    >
                      {save.isPending ? "Сохраняю…" : "Сохранить имя"}
                    </button>
                    <button className="pill ghost" type="button" onClick={() => setBrandFor(null)}>
                      Отмена
                    </button>
                    {a.brandName && (
                      <button
                        className="lnk"
                        type="button"
                        onClick={() => save.mutate({ id: a.id, channel: a.channel, title: a.title, brandName: "" })}
                      >
                        Вернуть «Royal Home»
                      </button>
                    )}
                  </div>
                </div>
              )}

              {promptFor === a.id && (
                <div style={{ padding: "var(--s3) var(--s2) var(--s4)" }}>
                  <div className="quiet">
                    <span className="dot" />
                    <span className="txt">
                      Как этот аккаунт разговаривает: роль, цель, тон, примеры фраз. Пусто — работает общий
                      промт из «ИИ-ассистента». Обязательные правила (кем себя называть, не выдумывать
                      объекты, география Душанбе) действуют всегда и отсюда не отменяются.
                    </span>
                  </div>
                  <label className="fld" style={{ marginTop: "var(--s3)" }}>
                    <span className="lab">Свой промт аккаунта</span>
                    <textarea
                      style={{ minHeight: 180, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}
                      value={draftPrompt}
                      onChange={(e) => setDraftPrompt(e.target.value)}
                      placeholder="Например: ты ведёшь информационный аккаунт Royal Home. Помогаешь советом по покупке и аренде, присылаешь чек-листы, отвечаешь на вопросы о вакансиях. Не навязываешь показы и не выпытываешь номер — если человек сам захочет купить, спокойно предложишь связать с агентом."
                    />
                  </label>
                  <div className="wrap" style={{ marginTop: "var(--s3)" }}>
                    <button
                      className="pill"
                      type="button"
                      disabled={save.isPending || draftPrompt === (a.systemPrompt ?? "")}
                      onClick={() =>
                        save.mutate({ id: a.id, channel: a.channel, title: a.title, systemPrompt: draftPrompt })
                      }
                    >
                      {save.isPending ? "Сохраняю…" : "Сохранить промт"}
                    </button>
                    <button className="pill ghost" type="button" onClick={() => setPromptFor(null)}>
                      Отмена
                    </button>
                    {a.systemPrompt && (
                      <button
                        className="lnk"
                        type="button"
                        onClick={() => {
                          if (
                            confirm(`Убрать свой промт у «${a.title}»? Аккаунт вернётся к общему промту из «Бот».`)
                          ) {
                            save.mutate({ id: a.id, channel: a.channel, title: a.title, systemPrompt: "" });
                          }
                        }}
                      >
                        Вернуть общий
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {adding === "INSTAGRAM" && (
        <div className="fgrid" style={{ marginTop: "var(--s4)" }}>
          <label className="fld">
            <span className="lab">Название для сотрудников</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Royal Home Info" />
          </label>
          <label className="fld">
            <span className="lab">Маркер доступа этого аккаунта</span>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="IGAA…" />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Meta → Instagram → «Настройка API», кнопка «Сгенерировать маркер». Показывается один раз.
              Идентификатор аккаунта вписывать не нужно — CRM спросит его у самой Meta по маркеру: в панели
              показан не тот номер, что приходит в сообщениях.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Как бот называет компанию (если не Royal Home)</span>
            <input value={brand} maxLength={20} onChange={(e) => setBrand(e.target.value)} placeholder="Арван" />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Для второго бренда на тех же фактах. Пусто — бот говорит «Royal Home».
            </span>
          </label>
          <div className="wide wrap">
            <button
              className="pill"
              type="button"
              disabled={save.isPending || !title.trim() || !token.trim()}
              onClick={() => save.mutate({ channel: "INSTAGRAM", title, token, brandName: brand.trim() })}
            >
              {save.isPending ? "Подключаю…" : "Подключить"}
            </button>
            <button className="pill ghost" type="button" onClick={() => setAdding(null)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {adding === "WHATSAPP" && (
        <div className="fgrid" style={{ marginTop: "var(--s4)" }}>
          <div className="wide quiet">
            <span className="dot" />
            <span className="txt">
              Номер подключается к тому же приложению Meta, что и основной: вебхук и секрет приложения общие.
              Маркер нужен отдельный, не тот, что у основного номера, — иначе CRM не сможет отличить номера
              при отправке.
            </span>
          </div>
          <label className="fld">
            <span className="lab">Название для сотрудников</span>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Арван, WhatsApp" />
          </label>
          <label className="fld">
            <span className="lab">Идентификатор номера (Phone number ID)</span>
            <input
              value={phoneId}
              inputMode="numeric"
              onChange={(e) => setPhoneId(e.target.value.trim())}
              placeholder="1129773893562843"
              aria-invalid={phoneId !== "" && !PHONE_NUMBER_ID.test(phoneId)}
            />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Meta → WhatsApp Manager → «Номера телефонов» → нужный номер → «Идентификатор номера телефона»
              (или в кабинете разработчика: WhatsApp → «Настройка API»). Это длинное число из цифр, а не сам
              телефон.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Маркер доступа этого номера</span>
            <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="EAA…" />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Meta → Бизнес-настройки → Системные пользователи → «Создать маркер», права
              whatsapp_business_messaging и whatsapp_business_management. Показывается один раз. CRM сверит
              маркер и номер с Meta и не примет нерабочий.
            </span>
          </label>
          <label className="fld">
            <span className="lab">Как бот называет компанию (если не Royal Home)</span>
            <input value={brand} maxLength={20} onChange={(e) => setBrand(e.target.value)} placeholder="Арван" />
            <span className="msg" style={{ color: "var(--faint)" }}>
              Для номера дочерней компании на тех же фактах. Пусто — бот говорит «Royal Home».
            </span>
          </label>
          <div className="wide wrap">
            <button
              className="pill"
              type="button"
              disabled={save.isPending || !title.trim() || !PHONE_NUMBER_ID.test(phoneId) || !token.trim()}
              onClick={() =>
                save.mutate({
                  channel: "WHATSAPP",
                  title,
                  externalId: phoneId,
                  token,
                  brandName: brand.trim(),
                  // Основной номер живёт в Настройках; этот — дополнительный, «по умолчанию» ему быть незачем.
                  isDefault: false,
                })
              }
            >
              {save.isPending ? "Проверяю у Meta…" : "Подключить номер"}
            </button>
            <button className="pill ghost" type="button" onClick={() => setAdding(null)}>
              Отмена
            </button>
          </div>
        </div>
      )}

      {items.length === 0 && adding === null && (
        <div className="quiet" style={{ marginTop: "var(--s2)" }}>
          <span className="dot" />
          <span className="txt">
            Пока список пуст — CRM работает на маркере из поля ниже, как раньше. Первый добавленный аккаунт
            станет основным.
          </span>
        </div>
      )}
    </div>
  );
}
