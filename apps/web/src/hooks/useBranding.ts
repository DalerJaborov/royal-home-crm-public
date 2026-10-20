import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

export interface Branding {
  companyName: string;
  companySlogan: string;
  companyLogoUrl: string | null;
}

const STORAGE_KEY = "royal-home-branding-cache";

let cached: Branding | null | undefined;

/** Последний известный логотип. Значение читается из localStorage один раз за
 *  загрузку и дальше отдаётся тем же объектом — иначе каждый рендер до ответа
 *  сервера возвращал бы новую ссылку и дёргал зависимости потребителей. */
function readCache(): Branding | null {
  if (cached === undefined) cached = parseCache();
  return cached;
}

function parseCache(): Branding | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Branding) : null;
  } catch {
    return null;
  }
}

function writeCache(branding: Branding) {
  cached = branding;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(branding));
  } catch {
    // localStorage недоступен — просто не кэшируем, следующий заход снова подождёт запрос.
  }
}

/**
 * Название/слоган/лого компании — публичный эндпоинт (без токена, нужен и на экране
 * входа). Раньше логотип на миг показывал синий значок-заглушку при каждой перезагрузке
 * страницы (пока запрос не ответил), а потом менялся на настоящий — заметное мигание
 * и в сайдбаре, и на входе. Теперь первый рендер сразу берёт последний известный логотип
 * из localStorage (если заходили раньше в этом браузере), а свежий запрос в фоне лишь
 * подтверждает/обновляет его — без видимой смены с одной иконки на другую.
 *
 * Запрос идёт через общий кэш запросов, а не через свой useEffect: хук вызывают
 * сразу три компонента (сайдбар, верхняя панель, экран входа), и раньше каждая
 * загрузка страницы била в /settings/branding по разу на каждого — пять-шесть
 * одинаковых запросов подряд за один рендер. Теперь он один на всё приложение.
 */
export function useBranding() {
  const { data } = useQuery<Branding>({
    queryKey: ["branding"],
    queryFn: () => api<Branding>("/settings/branding"),
    // Название и логотип меняются раз в жизни компании — перезапрашивать их
    // при каждом возврате на вкладку незачем.
    staleTime: 60 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  useEffect(() => {
    if (data) writeCache(data);
  }, [data]);

  return data ?? readCache();
}
