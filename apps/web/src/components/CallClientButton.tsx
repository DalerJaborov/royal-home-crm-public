import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Phone, X } from "lucide-react";
import { useCallClient } from "../hooks/useClients";
import { useCallCandidate } from "../hooks/useVacancies";
import { useActiveCallValue } from "../hooks/useActiveCall";
import { ApiError } from "../lib/apiError";
import { useAuthStore } from "../store/auth";

interface CallClientButtonProps {
  /** UUID клиента (Client.id, не shortId) — без него CRM-звонок совершить нечем
   *  (например, диалог бота ещё не сопоставлен с карточкой): кнопка сразу становится
   *  неактивной кнопкой с объяснением (звонка в обход станции нет). */
  clientId?: string | null;
  /** У клиента без телефона (лид из Telegram, диалог до "спросить телефон") сервер
   *  отдаёт null/undefined — раньше это падало прямо в рендере (прод 11.09, iPhone,
   *  главная: "undefined is not an object (evaluating 'o.includes')"). Тип честный:
   *  вызывающая сторона не обязана подставлять "" сама, кнопка держит защиту одна. */
  phone: string | null | undefined;
  /** Звонить не на основной номер карточки, а на этот (WhatsApp-номер, запасной) —
   *  владелец 20.08.2026: основной номер иногда недоступен, а другой у клиента
   *  рабочий. Сервер сам проверяет принадлежность карточке и что номер таджикский. */
  callPhone?: string;
  phoneKey?: string;
  /** icon — компактная кнопка для тесных списков/тайлов (только иконка).
   *  full — кнопка с подписью, как на карточке клиента. */
  variant?: "icon" | "full";
  /** Подпись рядом с иконкой в варианте full. По умолчанию — «Позвонить». */
  label?: string;
  className?: string;
  title?: string;
  /** Список внутри кликабельной строки — не даём клику по кнопке открыть карточку. */
  stopPropagation?: boolean;
  /** Анкета кандидата (раздел «Вакансии»): у неё нет карточки клиента, звонок
   *  идёт своим путём POST /vacancies/:id/call — тоже через станцию. */
  candidateId?: string;
}

/**
 * Текст отказа станции. 502/503/504 — станция или туннель до неё недоступны (см.
 * originateCallToClient в communications.ts). Если сервер успел сказать причину
 * JSON-ом («Asterisk отказал…», «не удалось соединиться…») — показываем её: по ней
 * директор понимает, что чинить. Прокси между CRM и браузером на «битом» шлюзе
 * иногда подменяет тело своей HTML-страницей — тогда остаётся общая фраза.
 */
/**
 * Что делать при 502/503/504 (глубокая проверка 02.10.2026, F13). 502 отдаёт и
 * станция через наш сервер (тело — JSON с причиной), и прокси перед сервером,
 * пока API перезапускается при выкате (тела нет или там HTML). Раньше оба
 * случая писали «нет связи со станцией» и сбрасывали весь кэш — лавина
 * перезапросов ровно в момент, когда сервер поднимается.
 *   • ответил наш сервер — текст про станцию; попытка засчитана агенту, данные
 *     надо перечитать (refresh);
 *   • ответил прокси — сервер CRM недоступен, кэш не трогаем.
 */
export function callFailureOutcome(err: ApiError): { text: string; refresh: boolean } {
  const fromOurServer = !!err.data && typeof err.data === "object";
  if (!fromOurServer) {
    return {
      text: "Сервер CRM сейчас не отвечает — возможно, идёт обновление. Попробуйте позвонить через минуту",
      refresh: false,
    };
  }
  return { text: stationErrorText(err), refresh: true };
}

function stationErrorText(err: ApiError): string {
  const reason =
    err.data && typeof err.data === "object" && typeof (err.data as { error?: unknown }).error === "string"
      ? (err.data as { error: string }).error
      : null;
  const base = "Нет связи с телефонной станцией, попробуйте через пару минут или сообщите директору";
  return reason ? `${base}. Причина: ${reason}` : base;
}

const DEFAULT_ICON_CLASS =
  "grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-blue/15 bg-blue/6 text-blue transition-colors hover:bg-blue/12 disabled:opacity-60";
const DEFAULT_FULL_CLASS =
  "flex items-center gap-1.5 text-[15px] font-semibold text-gray-700 border border-line bg-card rounded-lg px-3 py-1.5 hover:bg-hover-tint disabled:opacity-60";

/**
 * Единственное место, где живёт правило звонка клиенту (решение владельца 06.08.2026,
 * после жалобы «кнопка позвонить почему-то на мобильный звонит»): сначала CRM-звонок
 * через Asterisk ARI (POST /clients/:id/call, см. useCallClient) — запись разговора,
 * хронология, Royal Score. Голая ссылка tel: раньше стояла в пяти местах и звонила с
 * ЛИЧНОГО телефона агента мимо CRM. С 29.09.2026 запасного пути «с личного телефона»
 * нет вовсе (владелец: «убрать полностью у всех») — только станция.
 *
 * Не трогает apps/web/src/pages/TeamMemberDetail.tsx (карточка сотрудника) — там
 * телефон СОТРУДНИКА, а не клиента, и tel: там уместен как есть.
 */
export function CallClientButton({
  clientId,
  phone,
  callPhone,
  phoneKey,
  variant = "icon",
  label,
  className,
  title,
  stopPropagation = true,
  candidateId,
}: CallClientButtonProps) {
  const callClientMutation = useCallClient(clientId ?? "", callPhone, phoneKey);
  const callCandidate = useCallCandidate(candidateId ?? "");
  const callClient = candidateId ? callCandidate : callClientMutation;
  const [error, setError] = useState<string | null>(null);
  // Пока идёт звонок, кнопки заблокированы во ВСЕХ карточках: второй разговор,
  // не закончив первый, начать нельзя — станция позвонила бы на ту же занятую трубку.
  // Сервер это тоже не разрешает (409), но узнавать об этом из ошибки — плохо.
  const queryClient = useQueryClient();
  const readOnly = useAuthStore((state) => state.agent?.readOnly === true || state.agent?.role === "SHAREHOLDER");
  const { data: activeCall } = useActiveCallValue();
  const callInProgress = !!activeCall && activeCall.state !== "ended";
  const isThisClient = activeCall?.clientId === clientId;
  /** Телефона может не быть вовсе (лид без номера) — тогда это не маска, а пусто. */
  const safePhone = phone ?? "";
  const hasPhone = safePhone.length > 0;

  async function handleCall(e: React.MouseEvent) {
    if (stopPropagation) e.stopPropagation();
    if (readOnly) return;
    setError(null);
    try {
      await callClient.mutateAsync();
      // Окно звонка (CallWindow) читает состояние с сервера раз в секунду.
      // Дёргаем его сразу, чтобы экран вызова появился по нажатию, а не через паузу.
      await queryClient.invalidateQueries({ queryKey: ["active-call"] });
    } catch (err) {
      if (err instanceof ApiError && [502, 503, 504].includes(err.status)) {
        const outcome = callFailureOutcome(err);
        setError(outcome.text);
        // Отказ станции засчитан агенту как попытка (сервер, POST /clients/:id/call):
        // таймер первого звонка на карточке и на Главной гаснет — перечитываем
        // данные сразу, а не ждём следующего опроса. Бывает редко, поэтому всё.
        // Ответ прокси (сервер перезапускается) — не трогаем ничего.
        if (outcome.refresh) void queryClient.invalidateQueries();
      } else {
        setError(err instanceof Error ? err.message : "Не удалось совершить звонок");
      }
    }
  }

  // Ни карточки клиента, ни анкеты кандидата — CRM-звонок совершить нечем.
  // Звонка с личного телефона в обход станции больше нет нигде (владелец
  // 29.09.2026: «убрать полностью у всех»): неактивная кнопка с объяснением.
  if (readOnly) return null;
  if (!clientId && !candidateId) {
    return (
      <span
        title={
          !hasPhone
            ? "У клиента ещё нет телефона, звонить нечем"
            : "Звонок идёт только через CRM из карточки клиента, а карточки здесь нет или она вам недоступна (примите лид)"
        }
        className={`${className ?? (variant === "icon" ? DEFAULT_ICON_CLASS : DEFAULT_FULL_CLASS)} cursor-not-allowed opacity-50`}
      >
        <Phone className={variant === "icon" ? "h-3.5 w-3.5" : "w-3.5 h-3.5"} />
        {variant === "full" && (label ?? "Позвонить")}
      </span>
    );
  }

  return (
    <div className={variant === "icon" ? "relative shrink-0" : "relative"}>
      <button
        type="button"
        // Метка для жеста «смахнуть строку — позвонить» (components/SwipeRow.tsx):
        // жест находит эту кнопку внутри строки и нажимает её. Так правило звонка
        // остаётся в одном месте — сначала через CRM, а не голой ссылкой tel:.
        data-call-button
        onClick={handleCall}
        disabled={callClient.isPending || callInProgress}
        title={
          callInProgress
            ? isThisClient
              ? "Звонок этому клиенту уже идёт"
              : "Сначала завершите текущий разговор"
            : (title ?? (variant === "icon" ? "Позвонить через CRM" : undefined))
        }
        aria-label={variant === "icon" ? "Позвонить" : undefined}
        className={`${className ?? (variant === "icon" ? DEFAULT_ICON_CLASS : DEFAULT_FULL_CLASS)} ${
          callInProgress ? "cursor-not-allowed" : ""
        }`}
      >
        <Phone className={variant === "icon" ? "h-3.5 w-3.5" : "w-3.5 h-3.5"} />
        {variant === "full" &&
          (isThisClient && callInProgress
            ? "Идёт звонок…"
            : callInProgress
              ? "Линия занята"
              : callClient.isPending
                ? "Соединяем…"
                : (label ?? "Позвонить"))}
      </button>
      {error && (
        // bg-card-solid, а НЕ bg-card: обычный --c-card полупрозрачен (матовое стекло,
        // index.css) — карточка под попапом просвечивала сквозь текст ошибки.
        <div
          onClick={(e) => e.stopPropagation()}
          // На телефоне — плашкой по ширине экрана над нижним меню, а не у кнопки:
          // у кнопки слева окно, прижатое к её правому краю, уезжало за экран
          // (скриншот владельца 29.09.2026). На широком экране — как было.
          className="fixed inset-x-4 bottom-24 z-50 sm:absolute sm:inset-x-auto sm:bottom-auto sm:z-20 sm:top-full sm:mt-1.5 sm:right-0 sm:w-72 text-[15px] bg-card-solid border border-red/20 rounded-lg px-3 py-2.5 shadow-md"
        >
          <div className="flex items-start justify-between gap-2">
            <p className="text-red leading-snug">{error}</p>
            <button
              type="button"
              onClick={() => setError(null)}
              className="shrink-0 text-gray-400 hover:text-ink"
              aria-label="Скрыть"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          {/* Запасного пути «позвонить с личного телефона» больше нет (владелец
              29.09.2026): звонок только через станцию — с записью и учётом. */}
          {!hasPhone && (
            <p className="mt-1.5 text-[13px] leading-snug text-gray-500">
              У клиента ещё нет телефона: попросите его продиктовать номер.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
