import { useMemo } from "react";
import { useClients } from "../hooks/useClients";
import { SearchableSelect } from "./SearchableSelect";

/**
 * ВЫБОР ПРОДАВЦА ИЗ СВОЕГО СПИСКА (владелец 17.08.2026).
 *
 * «Либо выберите продавца из вашего списка, либо введите номер вручную» — здесь
 * первая половина; вторая это обычное поле «Контакт владельца» рядом.
 *
 * СПИСОК СУЖАЕТ САМ СЕРВЕР, А НЕ ЭТОТ КОМПОНЕНТ. GET /clients?kind=SELLER уже
 * ограничен своими карточками (scopeToOwnAgent в routes/clients.ts): рядовой агент
 * видит только закреплённых за ним, руководитель — всех. Ровно то, что просил
 * владелец («только своих продавцов»), и повторять это правило в интерфейсе не
 * нужно — второе место для одного правила разошлось бы с первым.
 *
 * pageSize=200 одной страницей: это справочник для селекта, а не лента. Больше
 * двухсот своих продавцов у агента не бывает, а листать выпадающий список нечем.
 */
export function SellerPicker({
  clientId,
  onPick,
}: {
  clientId: string;
  onPick: (seller: { id: string; assignedAgentId: string | null } | null) => void;
}) {
  const { data, isLoading } = useClients({ kind: "SELLER", pageSize: 200 });
  // Через useMemo, а не `data?.items ?? []` прямо в теле: пустой литерал — это
  // НОВЫЙ массив на каждый рендер, зависимость useMemo ниже менялась бы всегда,
  // и список вариантов пересобирался бы впустую. Поймано eslint'ом в CI.
  const sellers = useMemo(() => data?.items ?? [], [data]);
  const options = useMemo(
    () =>
      sellers.map((s) => ({
        value: s.id,
        // ПК-номер и телефон в подписи нарочно: у продавцов из мессенджеров имя
        // бывает нейтральным («Клиент из Instagram»), тёзки различаются только
        // номером карточки и телефоном (владелец 21.08.2026: «чтобы не перепутать»).
        label: [`ПК-${s.shortId}`, s.fullName, s.phone].filter(Boolean).join(" · "),
      })),
    [sellers]
  );
  const picked = clientId ? (sellers.find((s) => s.id === clientId) ?? null) : null;

  return (
    <>
      <span className="lab">
        Продавец объекта <span className="text-gray-500 font-normal">: выберите из ваших, если он уже в CRM</span>
      </span>
      {picked ? (
        // Выбранный продавец — карточкой с фото и номером, а не строкой в селекте:
        // агент видит, КОГО привязывает, до сохранения (владелец: «фотографии, имя,
        // телефон — чтобы не перепутать»).
        <div className="flex items-center gap-3 border border-line rounded-lg px-3 py-2.5 bg-card">
          {picked.avatarUrl ? (
            <img src={picked.avatarUrl} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
          ) : (
            <span className="w-9 h-9 rounded-full bg-gray-100 text-gray-500 flex items-center justify-center text-[15px] font-semibold shrink-0">
              {/* `?? ""` не косметика: в общей схеме имя клиента — `string | null`
                  (packages/shared/src/format.ts), и продавец без имени уронил бы
                  всю форму объекта. Тот же класс, что падение «Сообщений» 08.09. */}
              {(picked.fullName ?? "").trim().charAt(0).toUpperCase() || "?"}
            </span>
          )}
          <span className="min-w-0">
            <span className="block text-[15px] font-medium text-ink truncate">{picked.fullName}</span>
            <span className="block text-[13px] text-gray-500 truncate">
              ПК-{picked.shortId}
              {picked.phone ? ` · ${picked.phone}` : ""} · номер владельца подставится из карточки
            </span>
            {picked.assignedAgent && (
              // Владелец 06.09.2026 (разбор слепых зон п.1): у этой карточки уже есть
              // свой агент — подставлен в «Кто принял объект» на шаге 1 автоматически,
              // здесь просто видно, откуда взялось значение.
              <span className="block text-[13px] text-blue truncate">
                Уже закреплён за агентом {picked.assignedAgent.fullName} — подставлен как принявший объект
              </span>
            )}
          </span>
          <button
            type="button"
            onClick={() => onPick(null)}
            className="ml-auto shrink-0 text-[13px] text-blue hover:underline"
          >
            Убрать
          </button>
        </div>
      ) : (
        <>
          <SearchableSelect
            value={clientId}
            onChange={(id) => {
              const found = id ? sellers.find((s) => s.id === id) : undefined;
              onPick(found ? { id: found.id, assignedAgentId: found.assignedAgentId } : null);
            }}
            options={options}
            placeholder={isLoading ? "Загружаю продавцов..." : options.length > 0 ? "Найти по имени или номеру" : "Своих продавцов пока нет, заполните поля ниже"}
            disabled={isLoading || options.length === 0}
          />
          <p className="mt-1 text-[13px] text-gray-500">Нет в списке, просто заполните имя и телефон ниже.</p>
        </>
      )}
    </>
  );
}
