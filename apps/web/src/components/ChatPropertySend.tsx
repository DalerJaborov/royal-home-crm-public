import { useState } from "react";
import { Building2, Loader2 } from "lucide-react";
import { useClient, useClientMatch, useSendTarget } from "../hooks/useClients";
import { toast } from "../store/toast";
import { MatchPanel } from "./match/MatchPanel";
import { Rh2Sheet } from "./rh2/Rh2Sheet";

/**
 * КНОПКА-ЗДАНИЕ В КОМПОЗЕРЕ (владелец 21.08.2026: «найти объект прямо из чата
 * и отправить — быстро, без зависаний»; переделано 17.09.2026 вечер, «одна
 * функция «Подбор», не надо три разные»).
 *
 * РАНЬШЕ здесь был свой список объектов с поиском (`useProperties`) — третья
 * независимая реализация того же самого подбора, рядом с окном карточки
 * клиента и карточкой «Кому подойдёт» на объекте. Теперь кнопка просто
 * открывает ту же панель `MatchPanel` в режиме клиента: то же «Подбор» с
 * рекомендациями ИИ, каталогом-переключателем и массовой отправкой, что и на
 * карточке клиента — вместо трети функциональности в своём мини-окне.
 *
 * Сервер по-прежнему не тронут: `MatchPanel` шлёт ту же отправку через
 * `POST /clients/:id/send-properties`, что и раньше.
 *
 * Полная карточка клиента нужна панели (требования, хронология для отметки
 * «уже предлагали», желаемые районы) — а у диалога есть только `clientId`
 * (внутренний UUID) и `clientShortId` (короткий номер для `GET /clients/:id`,
 * который принимает именно его, не UUID). Поэтому запрос идёт по
 * `clientShortId`, и включается только пока панель открыта — как и раньше,
 * не тянем данные впустую при каждом открытом диалоге.
 *
 * ДВА ОТДЕЛЬНЫХ ИСПРАВЛЕНИЯ 19.09.2026 («не получается отправить прямо
 * объекты, кнопка не колыбельная [не кликабельная]»):
 *
 * 1. `layer="above-chat"` — мобильный чат занимает весь экран с z-index 45, а
 *    шторка `Rh2Sheet` рисуется порталом в `document.body` с z-index 41. Окно
 *    уезжало ПОД чат, а чат перехватывал нажатия: тап по значку не давал
 *    ничего. Сломалось 17.09.2026, когда кнопку перевели со своего списка
 *    внутри дерева чата на общую панель «Подбор» (PR #484).
 *
 * 2. `GET /clients/:shortId` — самый тяжёлый запрос CRM (до 200 записей
 *    хронологии, сделки, переписки). Раньше панель монтировалась ТОЛЬКО по
 *    `clientQuery.data`, поэтому между тапом и открытием не было ни спиннера,
 *    ни слова, а при отказе запроса (403 на непринятый чужой лид, обрыв связи)
 *    кнопка молчала навсегда: у запросов, в отличие от мутаций, глобального
 *    обработчика ошибок нет (lib/queryClient.ts). Теперь шторка открывается
 *    сразу и сама рассказывает, что происходит.
 */
export function ChatPropertySend({
  clientId,
  clientShortId,
  conversationId,
  disabled,
}: {
  clientId: string | null;
  clientShortId: string | null;
  /** Открытый диалог (id инбокса): объект уходит СЮДА, а не в «последний»
   *  диалог клиента. До 28.09.2026 из Instagram-чата он мог улететь в пустой
   *  WhatsApp, где Meta его не пропускала — «агенты не могут отправлять объекты». */
  conversationId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const clientQuery = useClient(open && clientShortId ? clientShortId : undefined);
  /**
   * БЕЗ ОЖИДАНИЯ ПО ОЧЕРЕДИ (28.09.2026, владелец: «на телефоне без
   * зависаний»). Подбор и «куда уйдёт» нужны только UUID клиента, который у
   * чата уже есть, — запускаем их ОДНОВРЕМЕННО с тяжёлой карточкой, а не после
   * неё. Ключи те же, что у `MatchPanel`: он берёт готовое из кэша.
   */
  useClientMatch(open && clientId ? clientId : undefined);
  useSendTarget(clientId ?? undefined, conversationId, open);
  const loading = open && clientQuery.isLoading;

  return (
    <>
      {/* 44x44 — единственные кнопки со значком без подложки в строке ответа,
          размер общий с ПК (сверка с макетом 390px, 10.09.2026). */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled || !clientId || !clientShortId}
        aria-label="Подбор"
        aria-haspopup="dialog"
        aria-busy={loading || undefined}
        title={
          clientId && clientShortId
            ? "Подбор — отправить объект клиенту"
            : "У диалога нет карточки клиента, сначала создайте лид"
        }
        className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-gray-400 hover:bg-line-soft hover:text-gray-600 disabled:opacity-40"
      >
        {/* Спиннер вместо значка, пока грузится карточка: на телефоне это
            единственный признак, что тап вообще дошёл. */}
        {loading ? (
          <Loader2 className="h-[18px] w-[18px] animate-spin" strokeWidth={1.8} />
        ) : (
          <Building2 className="h-[18px] w-[18px]" strokeWidth={1.8} />
        )}
      </button>

      {open && clientQuery.data && (
        <MatchPanel
          mode="client"
          client={clientQuery.data}
          open={open}
          onClose={() => setOpen(false)}
          onSent={() => {
            setOpen(false);
            // Окно закрылось вместе со строкой результата — подтверждение
            // одной строкой поверх чата, где сообщение и так видно.
            toast.success("Объект отправлен клиенту");
          }}
          layer="above-chat"
          conversationId={conversationId}
        />
      )}

      {/* Карточка ещё не пришла или не пришла вовсе — шторка всё равно открыта и
          говорит, что происходит, вместо мёртвой кнопки. */}
      {open && !clientQuery.data && (
        <Rh2Sheet
          title="Подбор"
          open
          onClose={() => setOpen(false)}
          layer="above-chat"
          footer={
            clientQuery.isError ? (
              <button type="button" className="pill" onClick={() => void clientQuery.refetch()}>
                Повторить
              </button>
            ) : undefined
          }
        >
          <p className={`state${clientQuery.isError ? " err" : ""}`}>
            {clientQuery.isError
              ? "Карточка клиента не загрузилась, подбор не открыть. Проверьте связь и повторите."
              : "Открываю карточку клиента…"}
          </p>
        </Rh2Sheet>
      )}
    </>
  );
}
