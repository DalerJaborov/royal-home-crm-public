import { useNavigate, useSearchParams } from "react-router-dom";
import { useCan } from "../../../lib/permissions";
import type { MhLaneChip } from "./MhList";

/**
 * ЛЕНТА СОСТОЯНИЙ ВНУТРИ РАЗДЕЛА КЛИЕНТОВ НА ТЕЛЕФОНЕ (переписана 21.09.2026).
 *
 * БЫЛО: лента «соседних разделов» — Продавцы, Покупатели, Неактивные,
 * Потерянные, Все мои, — то есть пять равноправных входов, из которых два
 * отвечали на вопрос «кто это», а три — «в каком он состоянии». Владелец:
 * «продавцы, покупатели — всё перемешано неправильно… откуда столько разделов,
 * всё перепутано? Должно быть всего 2 раздела — Продавцы, Покупатели, — а
 * когда в них заходишь, потом уже неактивные, потерянные».
 *
 * СТАЛО: вид выбирается верхней лентой раздела (ClientsTabs на широком экране,
 * заголовок экрана на телефоне), а здесь — состояние ВНУТРИ выбранного вида:
 * В работе · Неактивные · Потерянные (· Не на виду). Состав и правила ровно те
 * же, что у ленты широкого экрана (components/ClientsSectionLane.tsx), чтобы
 * телефон и компьютер не разошлись.
 *
 * Раздел едет параметром адреса (`?kind=`): «Неактивные» и «Потерянные» — один
 * маршрут на оба вида, и без параметра, уйдя от продавцов, человек возвращался
 * бы к покупателям.
 *
 * ЧИСЕЛ ЗДЕСЬ НЕТ. `GET /clients/summary` отдаёт «неактивных» и «потерянных»
 * общим числом, без разбивки по виду: показать это число у продавцов значило
 * бы соврать, а выдуманный ноль хуже отсутствия. Появится разбивка — появятся
 * и числа.
 *
 * «НЕ НА ВИДУ» — прежняя вкладка «Все мои» (18.09.2026, Р-2/Р-7
 * docs/audit/lead-ownership-17-09.md): единственное место, где держатель без
 * `archive.view`/`clients.assign` находит свою карточку, молча уехавшую в
 * Корзину/OTHER/LOST. Видна только тому, у кого нет `clients.viewAll`.
 */
export type MhClientSection = "buyers" | "sellers" | "inactive" | "lost" | "deferred" | "funnel" | "allMine";

export function useClientSectionChips(current: MhClientSection): MhLaneChip[] {
  const navigate = useNavigate();
  const can = useCan();
  const [searchParams] = useSearchParams();

  // Из какого раздела смотрим. На «Продавцах»/«Покупателях» это сам экран, на
  // общих маршрутах («Неактивные», «Потерянные») — параметр адреса; старая
  // ссылка без параметра читается как «Покупатели», лента всё равно ведёт в оба.
  const raw = searchParams.get("kind");
  const section: "SELLER" | "BUYER" =
    current === "sellers" ? "SELLER" : current === "buyers" ? "BUYER" : raw === "SELLER" ? "SELLER" : "BUYER";
  const inWork = section === "SELLER" ? "/sellers" : "/clients";
  const suffix = `?kind=${section}`;

  const all: Array<{ key: string; label: string; to: string; allowed: boolean; active: boolean }> = [
    {
      key: "inWork",
      label: "В работе",
      to: inWork,
      allowed: true,
      active: current === "sellers" || current === "buyers",
    },
    { key: "inactive", label: "Неактивные", to: `/inactive-clients${suffix}`, allowed: true, active: current === "inactive" },
    // «Отложенные» — тоже состояние клиента (23.09.2026): экран был, а попасть
    // на него было нельзя ни из меню, ни с ленты, только поиском.
    { key: "deferred", label: "Отложенные", to: "/deferred-clients", allowed: true, active: current === "deferred" },
    // «Воронка» — сводка тех же клиентов по стадиям (/lead-funnel): после
    // сокращения вкладок 21.09 на неё не вело ничего, кроме поиска.
    { key: "funnel", label: "Воронка", to: "/lead-funnel", allowed: true, active: current === "funnel" },
    {
      key: "lost",
      label: "Потерянные",
      to: `/lost-clients${suffix}`,
      allowed: can("clients.assign"),
      active: current === "lost",
    },
    {
      key: "allMine",
      label: "Не на виду",
      to: "/clients/all-mine",
      allowed: !can("clients.viewAll"),
      active: current === "allMine",
    },
  ];

  return all
    .filter((s) => s.allowed)
    .map((s) => ({ key: s.key, label: s.label, count: null, active: s.active, onSelect: () => navigate(s.to) }));
}
