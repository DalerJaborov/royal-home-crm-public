import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { usableRouteId } from "../lib/routeId";
import { useGoBack } from "../hooks/useGoBack";
import { PROPERTY_EDIT_LOCKED_MESSAGE, propertyEditLocked } from "@royal-home/shared";
import { RequestChangeSlot } from "../components/RequestChangeSlot";
import { PropertyFormModal } from "../components/PropertyFormModal";
import { useCan, useCanCreateProperty } from "../lib/permissions";
import { PropertyWizard } from "../components/property-wizard/PropertyWizard";
import { useProperty } from "../hooks/useProperties";
import { ApiError } from "../lib/apiError";
import { Rh2ErrorState, Rh2OfflineState, loadView } from "../components/rh2/Rh2ErrorState";
import { useLookAttribute, useRoyalLook } from "../hooks/useRoyalLook";
import { useWizardRoyalLook } from "../components/look/wizard/useWizardRoyalLook";
import { RoyalSection, useRoyalSectionName } from "../components/look/clients/RoyalSection";

/**
 * Полноэкранная форма объекта (/properties/new и /properties/:id/edit) в облике
 * эталона темы «Royal Home 2026».
 *
 * Разметка шапки взята из docs/pult/theme-2026/screens/property-form.html один в
 * один: `.scr` → `.pg-h` со ссылкой назад `.lnk`, заголовком и подписью
 * «Заполняйте сверху вниз», кнопкой «Закрыть» пилюлей в `.acts`. Секции полей
 * рисует сама форма (PropertyFormModal): она общая со окном на карточке
 * продавца, и облик у них теперь один.
 *
 * Автосохранения в CRM нет — черновик не хранится нигде, поэтому тихая строка
 * «Черновик сохранён в 13:07» из прототипа не переносится: обещать сохранение,
 * которого не происходит, нельзя. Вместо неё стоит честная строка о том, что
 * форма сохраняется кнопкой.
 */
function FormShell({
  title,
  sub,
  onClose,
  children,
}: {
  title: string;
  sub: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const section = useRoyalSectionName();
  return (
    <div className={section ? "rh2 screens ry-wiz-edit" : "rh2 screens"} data-ry-section={section}>
      <div className="scr">
        <div className="pg-h">
          <div>
            <Link className="lnk" to="/properties" style={{ paddingLeft: 0 }}>
              <svg className="i" viewBox="0 0 24 24" style={{ marginRight: 6 }}>
                <path d="M15 6l-6 6 6 6" />
              </svg>
              Объекты
            </Link>
            <h1 style={{ marginTop: 4 }}>{title}</h1>
            <p className="sub">{sub}</p>
          </div>
          <div className="acts">
            <button className="pill ghost" type="button" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </div>
        <div className="card tight">
          <div className="quiet">
            <span className="dot" />
            <span className="txt">
              Заполняйте сверху вниз. Черновик не сохраняется сам — объект появится в каталоге
              после кнопки внизу страницы.
            </span>
          </div>
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * НОВЫЙ ОБЪЕКТ — мастер из пяти шагов (components/property-wizard).
 *
 * Раньше здесь была та же длинная форма, что и при редактировании: два десятка
 * полей одним полотном. Заполнять её стоя в квартире невозможно — владелец
 * попросил разбить на шаги и добавить съёмку прямо из мастера. Редактирование
 * осталось на общей форме: там правят одно поле из двадцати, и шаги мешали бы.
 *
 * Своей шапки `FormShell` мастеру не нужно — он рисует собственную, со
 * счётчиком шагов и полосой прогресса.
 */
export function PropertyNew() {
  // «Закрыть» мастер — шаг назад туда, откуда пришли (список, карточка клиента), а не новый переход на список:
  // иначе за списком в истории оставался мастер (21.11.2026, разбор «Назад»).
  const closeWizard = useGoBack("/properties");
  const [searchParams] = useSearchParams();
  // «Новый вид» (пачка wizard, 20.11.2026). Мастер живёт СНАРУЖИ AppLayout (см.
  // App.tsx), а атрибут `data-ui-look` ставит только AppLayout и снимает при
  // уходе с его маршрутов — без этой строки слой нового вида до мастера не
  // доставал бы вовсе. Решение то же (сервер + чистая оболочка + личный выбор),
  // закрыто по умолчанию: нет признака — атрибута нет, ни одного пикселя.
  // Пока ответ сервера в пути (холодный заход), — запомненный на устройстве
  // признак, чтобы мастер не рисовался старым и не перекрашивался.
  const royal = useWizardRoyalLook();
  useLookAttribute(royal);
  // A12 (владелец 02.10.2026): СБ объекты не заводит. Кнопок у неё нет, а
  // прямая ссылка /properties/new уводит на список, а не в мастер, который
  // сервер всё равно не сохранит.
  const canCreateProperty = useCanCreateProperty();
  if (!canCreateProperty) return <Navigate to="/properties" replace />;
  return (
    <RoyalSection name={royal ? "wizard" : undefined}>
    <PropertyWizard
      onClose={closeWizard}
      initialIntakeAgentId={searchParams.get("intake") ?? undefined}
      // Баннер черновика на списке объектов уже спросил «продолжить?» — сюда
      // ведёт кнопкой «Продолжить», и в мастере вопрос повторять не за чем
      // (владелец 21.09.2026). Без параметра (прямая ссылка /properties/new,
      // кнопка «+» и т.п.) мастер всё равно спросит сам — блокирующим первым
      // экраном, см. PropertyWizard.tsx.
      autoContinueDraft={searchParams.get("draft") === "continue"}
      // Кнопка «Добавить объект» в чате продавца (21.09.2026, SellerObjectStrip /
      // ChatPhotoViewer) — мастер сам заводит черновик из переписки, см.
      // PropertyWizard.tsx::startFromClient.
      fromClientId={searchParams.get("fromClient") ?? undefined}
    />
    </RoyalSection>
  );
}

/** Полноэкранное редактирование объекта (/properties/:id/edit) — та же страница-раздел. */
export function PropertyEdit() {
  // «Новый вид»: метка раздела wizard на странице и на окнах формы (подтверждение
  // закрытия, выбор района) — без признака метки нет, разметка прежняя.
  const royal = useRoyalLook();
  return (
    <RoyalSection name={royal ? "wizard" : undefined}>
      <PropertyEditScreen />
    </RoyalSection>
  );
}

function PropertyEditScreen() {
  const section = useRoyalSectionName();
  const id = usableRouteId(useParams().id);
  const { data: property, isLoading, isError, error, fetchStatus, refetch, isFetching } = useProperty(id);
  const can = useCan();
  // Запасной путь — карточка того же объекта: человек пришёл править именно её,
  // и при прямом заходе (уведомление, закладка, обновление страницы) шаг назад
  // в истории уносил бы из приложения. Разбор — hooks/useGoBack.ts.
  const closeForm = useGoBack(id ? `/properties/${id}` : "/properties");

  if (isLoading) {
    return (
      <div className={section ? "rh2 screens ry-wiz-edit" : "rh2 screens"} data-ry-section={section}>
        <div className="scr">
          <div className="card">
            <div className="list">
              {Array.from({ length: 4 }).map((_, i) => (
                <div key={i} className="row">
                  <div className="t">
                    <span className="sk w40" />
                    <span className="sk w28" style={{ marginTop: 8 }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }
  // Нет связи (запрос на паузе) — не «объект не найден»: «Нет связи», загрузится сам (ревью #346).
  if (loadView({ data: property, isError, fetchStatus }) === "offline") {
    return (
      <div className={section ? "rh2 screens ry-wiz-edit" : "rh2 screens"} data-ry-section={section}>
        <div className="scr">
          <div className="card">
            <Rh2OfflineState onRetry={() => void refetch()} />
          </div>
        </div>
      </div>
    );
  }
  // Обрыв связи или сбой сервера — это не «объект не найден»: словами и с «Повторить» (К14, аудит 20.11.2026).
  const notFoundLike = isError && !property && error instanceof ApiError && (error.status === 404 || error.status === 403);
  if (isError && !property && !notFoundLike) {
    return (
      <div className={section ? "rh2 screens ry-wiz-edit" : "rh2 screens"} data-ry-section={section}>
        <div className="scr">
          <div className="card">
            <Rh2ErrorState message="Не удалось загрузить объект. Проверьте связь и нажмите «Повторить»." onRetry={() => void refetch()} retrying={isFetching} />
          </div>
        </div>
      </div>
    );
  }
  if (!property) {
    return (
      <div className={section ? "rh2 screens ry-wiz-edit" : "rh2 screens"} data-ry-section={section}>
        <div className="scr">
          <div className="card">
            <div className="empty">
              <span className="ic">
                <svg className="i" viewBox="0 0 24 24">
                  <path d="M3 11 12 3l9 8v10H3z" />
                  <path d="M9 21v-6h6v6" />
                </svg>
              </span>
              <p>Объект не найден.</p>
              <p className="sub">Его могли удалить или снять с продажи.</p>
              <Link className="pill ghost" to="/properties">
                К объектам
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }
  // Объект опубликован — форму не открываем, а говорим почему (правило одно с
  // сервером, @royal-home/shared propertyEditLocked; сервер всё равно ответит 409).
  // Агенту вместо формы — кнопка к заявке на изменение (блок на карточке объекта).
  if (propertyEditLocked(property, can("properties.editForeign"))) {
    return (
      <FormShell title="Изменить объект" sub={property.title} onClose={closeForm}>
        <div className="quiet" data-testid="property-edit-locked">
          <span className="dot" />
          <span className="txt">{PROPERTY_EDIT_LOCKED_MESSAGE}</span>
        </div>
        <RequestChangeSlot href={`/properties/${property.shortId}#change-requests`} />
      </FormShell>
    );
  }
  return (
    /* «Закрыть» и «Отмена» вели голым navigate(-1), без всякой проверки: форму
       открывают и прямой ссылкой (уведомление, закладка, обновление страницы) —
       тогда шаг назад уносил из приложения или не делал ничего. Запасной путь —
       карточка самого объекта: человек пришёл править именно её. */
    <FormShell title="Изменить объект" sub={property.title} onClose={closeForm}>
      <PropertyFormModal layout="page" property={property} onClose={closeForm} />
    </FormShell>
  );
}
