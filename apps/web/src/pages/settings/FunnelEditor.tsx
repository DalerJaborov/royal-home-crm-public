import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileText, Instagram, Trash2, Upload } from "lucide-react";
import { api } from "../../lib/api";
import {
  LEAD_MAGNET_DEFAULTS,
  LEAD_MAGNET_FILE_MAX_BYTES,
  QUICK_REPLY_TITLE_MAX,
  IG_CARD_TEXT_MAX,
  IG_MESSAGE_MAX,
} from "@royal-home/shared";
import { SwitchRow } from "../../components/Switch";
import { MutationError } from "../../components/MutationError";
import { KeywordTags } from "../../components/ui/KeywordTags";
import {
  useCreateLeadMagnet,
  useDeleteLeadMagnetFile,
  useUpdateLeadMagnet,
  useUploadLeadMagnetFile,
  type LeadMagnetCampaignRow,
} from "../../hooks/useLeadMagnets";

/**
 * Редактор кампании воронки — форма и живой предпросмотр переписки рядом.
 *
 * Предпросмотр здесь не украшение. Владелец задаёт четыре текста, которые человек
 * увидит по одному, с паузами, вперемешку со своими нажатиями, — собрать это в
 * голове из четырёх полей формы нельзя. Ошибка же стоит дорого: тексты уходят
 * посторонним людям с оплаченной рекламы, и «получилось не то» выясняется на
 * живой аудитории. Поэтому справа всегда видно ровно то, что придёт человеку.
 *
 * Разметка — эталон темы «Royal Home 2026»: карточки `.card` с шапкой
 * `.sec-h.stack`, поля `.fld`, тумблеры `.mod`, предпросмотр — пузыри `.bub`
 * в ленте `.thread`.
 */

/** Аккаунты канала — из того же списка, что рисует вкладка «Каналы». */
interface AccountOption {
  id: string;
  channel: string;
  title: string;
  enabled: boolean;
}

type Draft = {
  name: string;
  enabled: boolean;
  accountId: string;
  postUrl: string;
  /** ЕЩЁ публикации той же кампании — работают наравне с `postUrl`. */
  postUrls: string[];
  keywords: string[];
  anyComment: boolean;
  publicReplies: string[];
  inviteText: string;
  inviteButton: string;
  requireFollow: boolean;
  /** Подписка на ВСЕ наши аккаунты, а не только на тот, под чьим постом написали. */
  requireFollowAll: boolean;
  followText: string;
  followButton: string;
  notFollowingText: string;
  maxFollowChecks: number;
  deliverIfUnsure: boolean;
  /** Второе «я подписался» открывает выдачу, даже если подписки не видно. */
  deliverOnSecondClaim: boolean;
  deliveredText: string;
  link: string;
  handoffToBot: boolean;
};

function toDraft(campaign: LeadMagnetCampaignRow | null): Draft {
  return {
    name: campaign?.name ?? "",
    enabled: campaign?.enabled ?? false,
    accountId: campaign?.accountId ?? "",
    postUrl: campaign?.postUrl ?? "",
    postUrls: campaign?.postUrls ?? [],
    keywords: campaign?.keywords ?? [],
    anyComment: campaign?.anyComment ?? false,
    publicReplies: campaign?.publicReplies ?? ["Отправил в директ 📩"],
    inviteText: campaign?.inviteText ?? LEAD_MAGNET_DEFAULTS.inviteText,
    inviteButton: campaign?.inviteButton ?? LEAD_MAGNET_DEFAULTS.inviteButton,
    requireFollow: campaign?.requireFollow ?? true,
    requireFollowAll: campaign?.requireFollowAll ?? false,
    followText: campaign?.followText ?? LEAD_MAGNET_DEFAULTS.followText,
    followButton: campaign?.followButton ?? LEAD_MAGNET_DEFAULTS.followButton,
    notFollowingText: campaign?.notFollowingText ?? LEAD_MAGNET_DEFAULTS.notFollowingText,
    maxFollowChecks: campaign?.maxFollowChecks ?? 3,
    deliverIfUnsure: campaign?.deliverIfUnsure ?? true,
    deliverOnSecondClaim: campaign?.deliverOnSecondClaim ?? false,
    deliveredText: campaign?.deliveredText ?? LEAD_MAGNET_DEFAULTS.deliveredText,
    link: campaign?.link ?? "",
    handoffToBot: campaign?.handoffToBot ?? true,
  };
}

export function FunnelEditor({
  campaign,
  onClose,
}: {
  /** null — заводим новую кампанию. */
  campaign: LeadMagnetCampaignRow | null;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(campaign));
  const [error, setError] = useState<string | null>(null);
  // Тот же список, что на вкладке «Каналы». Только Instagram: воронка живёт на
  // комментариях, а их у нас ловит только он.
  const { data: accountsData } = useQuery<{ items: AccountOption[] }>({
    queryKey: ["messenger-accounts"],
    queryFn: () => api("/settings/messenger-accounts"),
  });
  const accounts = (accountsData?.items ?? []).filter((a) => a.channel === "INSTAGRAM");
  const create = useCreateLeadMagnet();
  // silent: форма ниже показывает отказ своим текстом (`error`) — общий тост
  // повторял его вторым сообщением. Тумблеры в списке кампаний тост сохраняют.
  const update = useUpdateLeadMagnet({ silent: true });
  const saving = create.isPending || update.isPending;
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  async function save() {
    setError(null);
    // Проверки повторяют серверную схему (leadMagnetCampaignInputSchema), но
    // говорят по-человечески и указывают на поле: 400 с деталями Zod владелец
    // читать не должен.
    if (!draft.name.trim()) return setError("Дайте кампании название — по нему вы найдёте её в списке");
    if (!draft.anyComment && draft.keywords.length === 0) {
      return setError("Добавьте ключевое слово или включите ответ на любой комментарий — иначе воронка не сработает ни разу");
    }
    // Публикация может быть и в основном поле, и в списке дополнительных — сервер
    // с 30.08.2026 считает достаточной ЛЮБУЮ из них, и форма обязана считать так же,
    // иначе кампания с тремя роликами и пустым верхним полем не сохранится вовсе.
    if (draft.anyComment && !draft.postUrl.trim() && !draft.postUrls.some((u) => u.trim())) {
      return setError("Для ответа на любой комментарий укажите публикацию: иначе воронка сработает под всеми постами сразу");
    }
    if (!campaign && draft.enabled) {
      return setError("Сначала сохраните кампанию и приложите файл, потом включайте — иначе первые пришедшие останутся ни с чем");
    }

    const body = {
      ...draft,
      // Пустая строка «Любой аккаунт» — это null, а не "": сервер отличает
      // «кампания ничьей публикации» от «аккаунт не выбран».
      accountId: draft.accountId || null,
      postUrl: draft.postUrl.trim() || null,
      // Пустые строки списка не отправляем: сервер их всё равно отбросит, но тогда
      // сохранённая кампания вернулась бы с другим списком, чем показывала форма.
      postUrls: draft.postUrls.map((u) => u.trim()).filter(Boolean),
      link: draft.link.trim() || null,
    };
    try {
      if (campaign) await update.mutateAsync({ id: campaign.id, ...body });
      else await create.mutateAsync(body);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Не удалось сохранить кампанию");
    }
  }

  return (
    <>
      <div className="pg-h">
        <div>
          <h1>{campaign ? campaign.name : "Новая кампания"}</h1>
          <p className="sub">Что ловим, что отвечаем и что выдаём человеку</p>
        </div>
        <div className="acts">
          <button className="pill ghost" type="button" onClick={onClose}>
            К списку
          </button>
        </div>
      </div>

      {/* Две колонки на большом экране, одна на телефоне. Предпросмотр внизу, а не
          сбоку: на телефоне он всё равно окажется под формой, и порядок «сначала
          заполняю, потом смотрю» там единственно возможный. */}
      <div className="fed">
        <div className="fed-form">
          <Card title="Что ловим" note="Комментарии какого аккаунта и под какой публикацией">
            <Field label="Название кампании" hint="Только для вас — в Instagram его никто не увидит.">
              <input
                value={draft.name}
                onChange={(e) => set("name", e.target.value)}
                placeholder="Чек-лист «Как покупать квартиру в Душанбе»"
              />
            </Field>

            {/* Аккаунт — ПЕРВЫМ после названия: он отвечает на вопрос «чьи
                комментарии ловим», а публикация ниже уточняет «какие именно».
                Появилось 17.08.2026 после живого случая с соавторским роликом. */}
            <Field
              label="Аккаунт Instagram"
              hint={
                accounts.length > 1
                  ? "Чьи комментарии ловит кампания. Если один ролик выложен на оба аккаунта соавторами, выберите аккаунт — иначе человек получит по приглашению от каждого."
                  : "Чьи комментарии ловит кампания."
              }
            >
              <select value={draft.accountId} onChange={(e) => set("accountId", e.target.value)}>
                <option value="">Любой аккаунт</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.title}
                    {a.enabled ? "" : " (выключен)"}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              label="Публикация в Instagram"
              hint="Скопируйте адрес ролика из приложения («Поделиться» → «Копировать ссылку»). Пусто — воронка ловит комментарии под всеми нашими публикациями."
            >
              <input
                value={draft.postUrl}
                onChange={(e) => set("postUrl", e.target.value)}
                placeholder="https://www.instagram.com/reel/..."
              />
            </Field>

            {/* Ещё публикации той же кампании (просьба владельца 30.08.2026). Раньше
                на каждый ролик заводили копию кампании, и копии расходились
                настройками: текст правили в одной, а реклама шла на другую. */}
            <Field
              label="Ещё публикации"
              hint="Те же тексты и тот же файл будут работать под каждым из этих роликов — заводить отдельную кампанию на каждый не нужно."
            >
              <UrlList values={draft.postUrls} onChange={(v) => set("postUrls", v)} max={POST_URLS_MAX} />
            </Field>

            {campaign && campaign.mediaIds?.length > 0 && (
              <div className="quiet">
                <span className="dot" />
                <span className="txt" style={{ wordBreak: "break-all" }}>
                  <b>Идентификаторы публикаций</b> — определены автоматически, менять их не нужно:{" "}
                  {campaign.mediaIds.join(", ")}
                </span>
              </div>
            )}

            <Field
              label="Ключевые слова"
              hint="Совпадение по вхождению и без учёта регистра: «ЧЕКЛИСТ» поймает и «хочу чек-лист пожалуйста». Дефисы и пробелы внутри слова не важны."
            >
              <KeywordTags values={draft.keywords} onChange={(v) => set("keywords", v)} placeholder="ЧЕКЛИСТ" />
            </Field>

            <SwitchRow
              title="Отвечать на любой комментарий"
              on={draft.anyComment}
              onToggle={() => set("anyComment", !draft.anyComment)}
              hint={
                draft.anyComment
                  ? "Файл получит каждый, кто напишет что угодно под указанной публикацией. Так делают, когда в ролике сказано «напиши что-нибудь под этим видео»."
                  : "Воронка срабатывает только на ключевые слова выше."
              }
            />
          </Card>

          <Card
            title="Ответ под публикацией"
            note="Короткая реплика под комментарием — её читают все. Задайте несколько вариантов: двадцать одинаковых ответов подряд выглядят накруткой. Оставьте список пустым, если публично отвечать не нужно"
          >
            <TextList
              values={draft.publicReplies}
              onChange={(v) => set("publicReplies", v)}
              placeholder="Отправил в директ 📩"
              addLabel="Ещё вариант"
              max={10}
              rows={2}
            />
          </Card>

          <Card
            title="Первое сообщение в директ"
            note="Instagram разрешает по комментарию отправить ровно одно сообщение. Поэтому первым уходит не файл, а кнопка: нажатие открывает переписку, и только после него мы можем проверить подписку и прислать PDF"
          >
            <Field label="Текст">
              <Textarea value={draft.inviteText} onChange={(v) => set("inviteText", v)} rows={3} withButton />
            </Field>
            <Field label="Надпись на кнопке">
              <ButtonInput value={draft.inviteButton} onChange={(v) => set("inviteButton", v)} />
            </Field>
          </Card>

          <Card title="Проверка подписки" note="Кому и когда выдаём файл">
            <SwitchRow
              title="Требовать подписку"
              on={draft.requireFollow}
              onToggle={() => set("requireFollow", !draft.requireFollow)}
              hint={
                draft.requireFollow
                  ? "После нажатия кнопки CRM спрашивает у Instagram, подписан ли человек. Подписан — выдаём сразу. Не подписан — пишем «подпишитесь» с кнопкой «Я подписался» и проверяем заново. Без подписки не выдаём."
                  : "Выдаём сразу после нажатия кнопки, подписку не проверяем вовсе. Так делают, когда цель — собрать переписки, а не подписчиков."
              }
            />
            {/* Показываем ВСЕГДА, а не только при включённой проверке: серый тумблер
                с видимой причиной честнее исчезнувшего — иначе о самой возможности
                узнать неоткуда. Причина написана словами рядом, не подсказкой. */}
            <SwitchRow
              title="Подписка на оба наших аккаунта"
              on={draft.requireFollowAll}
              disabled={!draft.requireFollow}
              onToggle={() => set("requireFollowAll", !draft.requireFollowAll)}
              hint={
                draft.requireFollowAll
                  ? "Требуем подписку на обе страницы — royal.home.tj и royalhome.info. Файл уйдёт только тому, кто подписан на обе."
                  : "Достаточно подписки на ту страницу, под чьей публикацией человек написал. На вторую подписываться не обязательно."
              }
              warning={!draft.requireFollow ? "Сначала включите «Требовать подписку» — без проверки подписки этот выбор ни на что не влияет." : null}
            />
            {draft.requireFollow && (
              <>
                <Field label="Просьба подписаться">
                  <Textarea value={draft.followText} onChange={(v) => set("followText", v)} rows={3} withButton />
                </Field>
                <Field label="Надпись на кнопке">
                  <ButtonInput value={draft.followButton} onChange={(v) => set("followButton", v)} />
                </Field>
                <Field
                  label="Если подписки всё ещё не видно"
                  hint="Подписка появляется у Instagram не мгновенно — человек мог всё сделать правильно."
                >
                  <Textarea value={draft.notFollowingText} onChange={(v) => set("notFollowingText", v)} rows={3} withButton />
                </Field>
                <Field
                  label="Сколько раз перепроверять"
                  hint="Человек, которого спрашивают четвёртый раз, уходит и жалуется на спам. После этого числа воронка замолкает и разговор продолжает обычный бот."
                >
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={draft.maxFollowChecks}
                    onChange={(e) => set("maxFollowChecks", Math.max(1, Math.min(10, Number(e.target.value) || 1)))}
                  />
                </Field>
                <SwitchRow
                  title="Выдавать, если Instagram не ответил про подписку"
                  on={draft.deliverIfUnsure}
                  onToggle={() => set("deliverIfUnsure", !draft.deliverIfUnsure)}
                  hint={
                    draft.deliverIfUnsure
                      ? "Речь не про «не подписан», а про «не смогли спросить»: Instagram иногда не отвечает на этот вопрос вовсе. Человек пришёл с оплаченной рекламы — наш сбой не повод оставлять его ни с чем."
                      : "Пока подписка не подтверждена, не выдаём — даже если причина в сбое Instagram, а не в человеке. Строгий вариант: подписка обязательна без исключений."
                  }
                />
              </>
            )}
            {/* Разбор прода 30.08.2026: человек подписывался, жал «Ман обуна шудам ✅»
                и получал «Обунаро ҳанӯз намебинам» — и так по кругу до предела
                проверок. Из 46 успешных выдач подписка подтвердилась у ВСЕХ, то есть
                неподтверждённым воронка не отдала файл ни разу. */}
            <SwitchRow
              title="Отдавать после второго «я подписался»"
              on={draft.deliverOnSecondClaim}
              disabled={!draft.requireFollow}
              onToggle={() => set("deliverOnSecondClaim", !draft.deliverOnSecondClaim)}
              hint={
                draft.deliverOnSecondClaim
                  ? "Человек второй раз нажал «Я подписался», а Instagram подписки по-прежнему не видит — верим человеку и отдаём файл."
                  : "Верим только Instagram: пока он подписку не подтвердит, файл не уйдёт, сколько бы раз человек ни нажал «Я подписался»."
              }
              warning={!draft.requireFollow ? "Сначала включите «Требовать подписку» — без проверки подписки кнопки «Я подписался» человек не увидит." : null}
            />
          </Card>

          {/* Три вида выдачи, и ни один не «правильнее» другого. Пишем это прямо,
              потому что пустое поле файла легко прочитать как незаконченную
              настройку — а это может быть осознанный выбор. */}
          <Card
            title="Что выдаём"
            note="Выдать можно файлом, ссылкой или просто текстом — что-то одно или всё сразу. Текст уходит всегда: в нём может быть и сам ответ, и промокод, и адрес офиса"
          >
            <Field label="Сообщение человеку">
              <Textarea value={draft.deliveredText} onChange={(v) => set("deliveredText", v)} rows={3} />
            </Field>
            {campaign ? (
              <FileBox campaign={campaign} />
            ) : (
              <div className="quiet">
                <span className="dot" />
                <span className="txt">
                  Файл прикладывается после сохранения — сначала создайте кампанию. Если выдаёте ссылкой или
                  текстом, файл не нужен вовсе.
                </span>
              </div>
            )}
            <Field
              label="Ссылка"
              hint="Уходит отдельным сообщением — так она кликабельна. Подойдёт Google Диск, страница сайта, канал. Если приложен файл, ссылка остаётся запасным путём на случай, когда Instagram файл не принял."
            >
              <input
                value={draft.link}
                onChange={(e) => set("link", e.target.value)}
                placeholder="https://royalhome.tj/checklist"
              />
            </Field>
            <div className="quiet">
              <span className="dot ok" />
              <span className="txt">
                <b>Человек получит:</b> {whatArrives(draft, campaign?.fileName ?? null)}
              </span>
            </div>
          </Card>

          <Card title="После выдачи" note="Кто продолжает разговор">
            <SwitchRow
              title="Разговор продолжает бот"
              on={draft.handoffToBot}
              onToggle={() => set("handoffToBot", !draft.handoffToBot)}
              hint={
                draft.handoffToBot
                  ? "Человек получил файл и спросил про квартиры — отвечает обычный бот, как в любой переписке. Так из чек-листа получается лид."
                  : "Бот молчит: переписка копится в CRM, отвечает живой сотрудник. Экономит токены на большой рекламе."
              }
            />
          </Card>

          <div className="card tight">
            {error && (
              <div className="quiet crit" role="alert">
                <span className="dot crit" />
                <span className="txt">{error}</span>
              </div>
            )}
            <MutationError mutation={create} fallback="Не удалось создать кампанию" variant="rh2" />
            <MutationError mutation={update} fallback="Не удалось сохранить кампанию" variant="rh2" />
            <div className="wrap">
              <button className="pill" type="button" onClick={save} disabled={saving}>
                {saving ? "Сохраняем…" : campaign ? "Сохранить" : "Создать кампанию"}
              </button>
              <button className="pill ghost" type="button" onClick={onClose}>
                Отмена
              </button>
            </div>
          </div>
        </div>

        <Preview draft={draft} fileName={campaign?.fileName ?? null} />
      </div>
    </>
  );
}

/** Предел списка дополнительных публикаций — тот же, что в схеме сервера
 *  (`postUrls: …max(20)`). Разъехавшись, форма позволила бы набрать двадцать первый
 *  адрес и получить отказ уже на «Сохранить». */
const POST_URLS_MAX = 20;

/** Одной фразой: что именно придёт человеку. Три поля («текст», «файл», «ссылка»)
 *  по отдельности не отвечают на этот вопрос, а он единственный, который владелец
 *  задаёт перед запуском рекламы. */
function whatArrives(draft: Draft, fileName: string | null): string {
  const parts = ["сообщение"];
  if (fileName) parts.push(`файл «${fileName}»`);
  if (draft.link.trim()) parts.push(fileName ? "и ссылку, если файл не пройдёт" : "ссылку");
  return parts.length === 1 ? "только сообщение — файла и ссылки нет" : parts.join(", ");
}

function Card({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <div className="sec-h stack">
        <h2>{title}</h2>
        {note && <span className="note">{note}</span>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="fld" style={{ marginTop: "var(--s4)" }}>
      <span className="lab">{label}</span>
      {children}
      {hint && (
        <span className="msg" style={{ color: "var(--faint)" }}>
          {hint}
        </span>
      )}
    </label>
  );
}

/**
 * Текст сообщения со счётчиком.
 *
 * Предел у шагов разный, и это не придирка. Сообщение С КНОПКОЙ Meta шлёт
 * карточкой, где всего 80 знаков на строку: длинный текст она режет пополам, и
 * хвост повисает над кнопкой отдельной серой строкой — владелец увидел это на
 * живом клиенте 17.08.2026 («...ба тугмаи зерин» / «пахш кунед»). Обычное
 * сообщение без кнопки такого ограничения не имеет.
 */
function Textarea({
  value,
  onChange,
  rows,
  withButton = false,
}: {
  value: string;
  onChange: (v: string) => void;
  rows: number;
  /** У шага есть кнопка — значит это карточка, и текст обязан быть коротким. */
  withButton?: boolean;
}) {
  const max = withButton ? IG_CARD_TEXT_MAX : IG_MESSAGE_MAX;
  const left = max - value.length;
  return (
    <>
      <textarea value={value} rows={withButton ? 2 : rows} maxLength={max} onChange={(e) => onChange(e.target.value)} />
      <span className="msg" style={{ color: left < (withButton ? 15 : 100) ? "var(--warn)" : "var(--faint)" }}>
        {withButton ? `осталось ${left} — текст идёт над кнопкой, поместиться должен целиком` : `осталось ${left}`}
      </span>
    </>
  );
}

/** Надпись на кнопке. Двадцать знаков — жёсткий предел Meta: одна лишняя буква, и
 *  сообщение не уходит целиком, вместе с кнопкой. */
function ButtonInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input
        value={value}
        maxLength={QUICK_REPLY_TITLE_MAX}
        onChange={(e) => onChange(e.target.value)}
        style={{ maxWidth: 260 }}
      />
      <span className="msg" style={{ color: "var(--faint)" }}>
        {value.length} из {QUICK_REPLY_TITLE_MAX} знаков — предел Instagram
      </span>
    </>
  );
}

/**
 * Список ДОПОЛНИТЕЛЬНЫХ публикаций кампании.
 *
 * Пустая строка здесь — законное промежуточное состояние: её только что добавили
 * кнопкой и ещё не вставили адрес. Поэтому пустые строки живут в форме, но при
 * сохранении отбрасываются (см. `postUrls` в `save`) — ровно как их отбрасывает
 * сервер, чтобы сохранённая кампания не вернулась с другим списком, чем показывала
 * форма.
 */
function UrlList({ values, onChange, max }: { values: string[]; onChange: (v: string[]) => void; max: number }) {
  const filled = values.filter((v) => v.trim()).length;
  return (
    <>
      {values.map((value, i) => (
        <div className="wrap" key={i} style={{ marginBottom: "var(--s2)", flexWrap: "nowrap" }}>
          <input
            value={value}
            maxLength={500}
            placeholder="https://www.instagram.com/reel/..."
            onChange={(e) => onChange(values.map((v, j) => (j === i ? e.target.value : v)))}
          />
          <button
            className="pill ghost sm"
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            aria-label="Убрать публикацию"
          >
            <Trash2 className="i" aria-hidden="true" />
          </button>
        </div>
      ))}
      <div className="wrap">
        {values.length < max ? (
          <button className="pill ghost sm" type="button" onClick={() => onChange([...values, ""])}>
            Ещё публикация
          </button>
        ) : (
          // Причина, по которой кнопки больше нет, — видимым текстом: пропавшая
          // кнопка без объяснения читается как поломка.
          <span className="saved">Больше {max} публикаций в одну кампанию добавить нельзя — это предел.</span>
        )}
        {filled > 0 && (
          <span className="saved">
            Всего адресов заполнено: {filled} из {max}. Пустые строки не сохраняются.
          </span>
        )}
      </div>
    </>
  );
}

/** Список текстов с добавлением и удалением — варианты публичного ответа. */
function TextList({
  values,
  onChange,
  placeholder,
  addLabel,
  max,
  rows,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  addLabel: string;
  max: number;
  rows: number;
}) {
  return (
    <div className="fld">
      {values.map((value, i) => (
        <div className="wrap" key={i} style={{ marginBottom: "var(--s2)", flexWrap: "nowrap", alignItems: "flex-start" }}>
          <textarea
            value={value}
            rows={rows}
            maxLength={280}
            placeholder={placeholder}
            onChange={(e) => onChange(values.map((v, j) => (j === i ? e.target.value : v)))}
          />
          <button
            className="pill ghost sm"
            type="button"
            onClick={() => onChange(values.filter((_, j) => j !== i))}
            aria-label="Убрать вариант"
          >
            <Trash2 className="i" aria-hidden="true" />
          </button>
        </div>
      ))}
      {values.length < max && (
        <div className="wrap">
          <button className="pill ghost sm" type="button" onClick={() => onChange([...values, ""])}>
            {addLabel}
          </button>
        </div>
      )}
    </div>
  );
}

/** Файл кампании: загрузка, замена, удаление и честный ответ про адрес CRM. */
function FileBox({ campaign }: { campaign: LeadMagnetCampaignRow }) {
  const upload = useUploadLeadMagnetFile();
  const remove = useDeleteLeadMagnetFile();
  const [tooBig, setTooBig] = useState(false);

  function choose(file: File | undefined) {
    setTooBig(false);
    if (!file) return;
    // Проверяем здесь тоже: 25 МБ через мобильный интернет уходят долго, и узнать
    // об отказе после загрузки — худший вариант.
    if (file.size > LEAD_MAGNET_FILE_MAX_BYTES) return setTooBig(true);
    upload.mutate({ id: campaign.id, file });
  }

  return (
    <div style={{ marginTop: "var(--s4)" }}>
      <div className="grp-lab">Файл (PDF)</div>
      {campaign.fileName ? (
        <div className="row">
          <FileText className="i lg" aria-hidden="true" />
          <div className="t">
            <b>{campaign.fileName}</b>
            <span>
              {campaign.fileSize ? `${Math.round(campaign.fileSize / 1024)} КБ` : ""}
              {campaign.fileUrl && (
                <>
                  {" · "}
                  <a className="lk" href={campaign.fileUrl} target="_blank" rel="noreferrer">
                    открыть
                  </a>
                </>
              )}
            </span>
          </div>
          <div className="act">
            <button
              className="pill ghost sm"
              type="button"
              onClick={() => remove.mutate(campaign.id)}
              disabled={remove.isPending}
            >
              Убрать
            </button>
          </div>
        </div>
      ) : (
        <label
          className="wrap"
          style={{
            justifyContent: "center",
            border: "1px dashed var(--line-strong)",
            borderRadius: "var(--r-md)",
            padding: "var(--s5) var(--s3)",
            cursor: "pointer",
            color: "var(--muted)",
          }}
        >
          <Upload className="i" aria-hidden="true" />
          {upload.isPending ? "Загружаем…" : "Выберите PDF до 25 МБ"}
          <input
            type="file"
            accept="application/pdf,.pdf"
            style={{ display: "none" }}
            onChange={(e) => choose(e.target.files?.[0])}
          />
        </label>
      )}
      {tooBig && (
        <div className="quiet crit" role="alert">
          <span className="dot crit" />
          <span className="txt">Instagram принимает файл до 25 МБ — этот тяжелее. Сожмите PDF или дайте ссылку.</span>
        </div>
      )}
      {campaign.filePath && !campaign.fileUrl && (
        <div className="quiet warn">
          <span className="dot warn" />
          <span className="txt">
            Файл загружен, но публичный адрес CRM не настроен (CRM_PUBLIC_URL) — Instagram не сможет его
            забрать. Пока так, людям будет уходить запасная ссылка.
          </span>
        </div>
      )}
      <MutationError mutation={upload} fallback="Не удалось загрузить файл" variant="rh2" />
      <MutationError mutation={remove} fallback="Не удалось убрать файл" variant="rh2" />
    </div>
  );
}

/**
 * Предпросмотр переписки — ровно то, что увидит человек, и в том же порядке.
 *
 * Показываем обе ветки сразу (подписан / не подписан): владельцу важно видеть, что
 * будет с тем, кто НЕ подписан, — именно там воронка теряет людей.
 */
function Preview({ draft, fileName }: { draft: Draft; fileName: string | null }) {
  const publicReply = draft.publicReplies.find((t) => t.trim());

  return (
    <aside className="card fed-prev">
      <div className="sec-h stack">
        <h2>
          <Instagram className="i lg" aria-hidden="true" /> Как это увидит человек
        </h2>
      </div>

      <div className="grp-lab">1 · Под роликом</div>
      <div className="thread">
        <div className="bub">
          {draft.keywords[0] ?? (draft.anyComment ? "любой комментарий" : "ключевое слово")}
        </div>
        {publicReply ? <div className="bub me">{publicReply}</div> : <span className="saved">публично не отвечаем</span>}
      </div>

      <div className="grp-lab">2 · В личных сообщениях</div>
      <div className="thread">
        <Bubble button={draft.inviteButton}>{draft.inviteText}</Bubble>
      </div>

      {draft.requireFollow ? (
        <>
          <div className="grp-lab">3 · Подписан</div>
          <div className="thread">
            <Bubble>{draft.deliveredText}</Bubble>
            <FileBubble name={fileName} link={draft.link} />
          </div>
          <div className="grp-lab">3 · Не подписан</div>
          <div className="thread">
            <Bubble button={draft.followButton}>{draft.followText}</Bubble>
            <div className="bub">нажал кнопку</div>
            <Bubble>{draft.deliveredText}</Bubble>
            <FileBubble name={fileName} link={draft.link} />
          </div>
        </>
      ) : (
        <>
          <div className="grp-lab">3 · Сразу после нажатия</div>
          <div className="thread">
            <Bubble>{draft.deliveredText}</Bubble>
            <FileBubble name={fileName} link={draft.link} />
          </div>
        </>
      )}
    </aside>
  );
}

/** Наш пузырь: `.bub.me` эталона, с подписью кнопки под текстом. */
function Bubble({ button, children }: { button?: string; children: React.ReactNode }) {
  return (
    <div className="bub me">
      <span style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{children}</span>
      {button && (
        <span className="chip hot" style={{ marginTop: 6 }}>
          {button}
        </span>
      )}
    </div>
  );
}

function FileBubble({ name, link }: { name: string | null; link: string }) {
  if (name) {
    return (
      <div className="bub me">
        <FileText className="i" aria-hidden="true" /> {name}
      </div>
    );
  }
  if (link.trim()) {
    return (
      <div className="bub me" style={{ wordBreak: "break-all" }}>
        {link}
      </div>
    );
  }
  // Ни файла, ни ссылки — законный вид кампании: обещанное могло быть промокодом
  // или адресом прямо в тексте выше. Раньше здесь стояло красное «человеку ничего
  // не придёт», и это была неправда.
  return <span className="saved">дальше только текст выше</span>;
}
