import { useEffect, useState } from "react";
import { Inbox, MessageCircle, MoreHorizontal, Phone, Plus } from "lucide-react";
import {
  Button,
  Card,
  Chip,
  Filters,
  List,
  PageHeader,
  Rh2EmptyState,
  Rh2Screen,
  Rh2Sheet,
  Row,
  Segment,
  Skeleton,
  Tabs,
  Tile,
  Tiles,
} from "../../components/rh2";
import type { ChipTone, RowAvatar } from "../../components/rh2";
import { ConfirmDialog } from "../../components/ConfirmDialog";

/**
 * Витрина набора «Royal Home 2026» — живая версия дизайн-контракта
 * (`docs/design/contract-2026-10/`). Только `import.meta.env.DEV`: маршрут
 * `/dev/design-lab` регистрируется в App.tsx под тем же условием, что и
 * остальные `pages/dev/*`, в прод-бандл не попадает.
 *
 * Зачем: владелец утверждает облик по контракту, а дальше смотрит ЭТУ страницу
 * на стенде, с настоящими классами темы и настоящими компонентами
 * `components/rh2`. Что выглядит иначе, чем в контракте, чинится в теме или в
 * компоненте, а не в картинке. Данные ниже — тестовые (как в seed), не из
 * рабочей базы.
 *
 * C (06.10.2026): каждый компонент набора во всех вариантах и состояниях,
 * переключатель светлая/ночная тема и рядом рамка шириной 390 с тем же
 * содержимым. ОГРАНИЧЕНИЕ РАМКИ: это блок шириной 390 внутри страницы, а не
 * окно телефона. Медиа-запросы темы (820 и 640) смотрят на ширину ОКНА
 * браузера, поэтому «телефонная» раскладка строки и шапки в рамке не
 * включится; для неё сужайте окно или эмулируйте устройство. Рамка проверяет
 * другое: что компоненты не ломаются и не вылезают по ширине 390.
 *
 * `data-testid` на каждом блоке: `lab-<блок>` в основной колонке и
 * `lab-<блок>-390` в рамке. По ним сборщик снимает кадры.
 */

type Action = { label: string; tone: ChipTone };

const CLIENTS: ReadonlyArray<{
  name: string;
  line: string;
  avatar: RowAvatar;
  chip?: Action;
  meta: string;
}> = [
  { name: "Фаррух Назаров", line: "Показ · 3-комн · ул. Айни, 24", avatar: { label: "ФН", tone: "lime" }, chip: { label: "показ сегодня 14:00", tone: "lav" }, meta: "14:00" },
  { name: "Ситора Назарова", line: "Пришла в офис, смотрит дом с гаражом", avatar: { label: "СН", tone: "sky" }, chip: { label: "первый звонок", tone: "warn" }, meta: "сегодня" },
  { name: "Комрон Валиев", line: "Не отвечает 2 недели", avatar: { label: "КВ" }, chip: { label: "принять лид", tone: "crit" }, meta: "2 окт" },
  { name: "Джамшед Расулов", line: "2 комн · Фирдавси · до $45 тыс. · WhatsApp", avatar: { label: "ДР", tone: "aqua" }, chip: { label: "ответить", tone: "warn" }, meta: "вчера" },
  { name: "Умед Собиров", line: "3 комн · Сино · до $40 тыс. · Facebook", avatar: { label: "УС", tone: "pink" }, meta: "3 окт" },
];

const CLIENT_CHIPS: ReadonlyArray<Action> = [
  { label: "принять лид", tone: "crit" },
  { label: "позвонить сейчас", tone: "warn" },
  { label: "ответить", tone: "warn" },
  { label: "первый звонок", tone: "warn" },
  { label: "показ сегодня 14:00", tone: "lav" },
];

const STAGE_CHIPS: ReadonlyArray<Action> = [
  { label: "проверка", tone: "neutral" },
  { label: "фото", tone: "sky" },
  { label: "видео", tone: "sky" },
  { label: "монтаж", tone: "lav" },
  { label: "в продаже", tone: "ok" },
  { label: "резерв", tone: "aqua" },
  { label: "продано", tone: "neutral" },
];

const FILTERS = [
  { id: "all", label: "Все", count: 24 },
  { id: "flat", label: "Квартиры", count: 15 },
  { id: "house", label: "Дома", count: 6 },
  { id: "shop", label: "Коммерция", count: 3 },
] as const;

const TABS = [
  { id: "work", label: "В работе", count: 6 },
  { id: "idle", label: "Неактивные", count: 2 },
  { id: "lost", label: "Потерянные", count: 1 },
] as const;

const KINDS = [
  { id: "sellers", label: "Продавцы" },
  { id: "buyers", label: "Покупатели" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];
type TabId = (typeof TABS)[number]["id"];
type KindId = (typeof KINDS)[number]["id"];
type Section = "kit" | "clients" | "empty";
type LabTheme = "royal-home-2026-light" | "royal-home-2026-night";

export function DesignLabPlayground() {
  if (!import.meta.env.DEV) return null;
  return <Lab />;
}

/** Тема страницы: меняем атрибут на `<html>` и возвращаем прежнее при уходе. */
function useLabTheme(): [LabTheme, (t: LabTheme) => void] {
  const [theme, setTheme] = useState<LabTheme>(() =>
    document.documentElement.dataset.theme === "royal-home-2026-night" ? "royal-home-2026-night" : "royal-home-2026-light",
  );
  useEffect(() => {
    const root = document.documentElement;
    const before = root.dataset.theme;
    root.dataset.theme = theme;
    return () => {
      if (before) root.dataset.theme = before;
    };
  }, [theme]);
  return [theme, setTheme];
}

function Lab() {
  const [section, setSection] = useState<Section>("kit");
  const [theme, setTheme] = useLabTheme();

  return (
    <Rh2Screen>
      <div data-testid="design-lab" style={{ display: "flex", flexDirection: "column", gap: 24, padding: "16px 0 96px" }}>
        <PageHeader
          title="Витрина набора"
          sub="Живая версия контракта: настоящие классы темы и компоненты rh2. Данные тестовые."
          actions={
            <>
              <Segment
                aria-label="Тема"
                data-testid="lab-theme"
                value={theme}
                onChange={setTheme}
                options={[
                  { id: "royal-home-2026-light", label: "Светлая" },
                  { id: "royal-home-2026-night", label: "Ночная" },
                ]}
              />
              <Tabs<Section>
                aria-label="Раздел витрины"
                value={section}
                onChange={setSection}
                options={[
                  { id: "kit", label: "Набор" },
                  { id: "clients", label: "Клиенты" },
                  { id: "empty", label: "Пусто" },
                ]}
              />
            </>
          }
        />

        {section === "kit" && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 32, alignItems: "flex-start" }}>
            <div style={{ flex: "1 1 560px", minWidth: 0, display: "flex", flexDirection: "column", gap: 24 }}>
              <Kit suffix="" />
            </div>
            <div
              data-testid="lab-frame-390"
              style={{ width: 390, flex: "none", display: "flex", flexDirection: "column", gap: 16 }}
            >
              <p className="sec-t" style={{ margin: 0 }}>Рамка 390 px</p>
              <div style={{ width: 390, display: "flex", flexDirection: "column", gap: 24 }}>
                <Kit suffix="-390" />
              </div>
            </div>
          </div>
        )}

        {section === "clients" && <ClientsScreen />}

        {section === "empty" && (
          <Card>
            <Rh2EmptyState
              icon={Inbox}
              title="Потерянных пока нет"
              hint="Сюда попадают клиенты без ответа дольше 14 дней."
              action={<Button size="sm" variant="soft">К клиентам</Button>}
            />
          </Card>
        )}
      </div>
    </Rh2Screen>
  );
}

/** Все компоненты набора. Рендерится дважды: основная колонка и рамка 390. */
function Kit({ suffix }: { suffix: "" | "-390" }) {
  const id = (name: string) => `lab-${name}${suffix}`;
  const [filter, setFilter] = useState<FilterId>("all");
  const [tab, setTab] = useState<TabId>("work");
  const [kind, setKind] = useState<KindId>("buyers");
  const [sheetOpen, setSheetOpen] = useState(false);
  const [confirm, setConfirm] = useState<null | "danger" | "plain" | "blocked">(null);
  const [rowClicks, setRowClicks] = useState(0);
  const [actionClicks, setActionClicks] = useState(0);

  return (
    <>
      <Card data-testid={id("buttons")} title="Кнопки">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button>Записать встречу</Button>
          <Button variant="soft">Переписка</Button>
          <Button variant="ghost">Отложить</Button>
          <Button variant="danger">В потерянные</Button>
          <Button variant="icon" aria-label="Ещё"><MoreHorizontal size={18} aria-hidden /></Button>
          <Button variant="call" aria-label="Позвонить"><Phone size={18} aria-hidden /></Button>
          <Button variant="fab" aria-label="Добавить"><Plus size={22} aria-hidden /></Button>
        </div>
        <p className="sec-t">Размер sm: видимые 40, зона нажатия 44</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button size="sm">Маленькая</Button>
          <Button size="sm" variant="soft" icon={<MessageCircle size={16} aria-hidden />}>Написать</Button>
          <Button size="sm" variant="ghost">Фильтры</Button>
          <Button size="sm" variant="danger">Удалить</Button>
        </div>
        <p className="sec-t">Состояния</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <Button loading>Сохраняем</Button>
          <Button variant="soft" loading>Загружаем</Button>
          <Button disabled disabledReason="Укажите телефон">Сохранить</Button>
          <Button variant="ghost" disabled disabledReason="Выберите хотя бы одну карточку">Передать</Button>
          <Button onClick={() => setSheetOpen(true)}>Открыть шторку</Button>
        </div>
        <div className="quiet">
          <span className="dot" />
          Неактивная кнопка всегда говорит, чего не хватает (подсказка при наведении). Тип не даёт собрать disabled без причины.
        </div>
      </Card>

      <Card data-testid={id("chips")} title="Чипы">
        <p className="sec-t" style={{ marginTop: 0 }}>Клиент: один чип, называет действие</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {CLIENT_CHIPS.map((c) => <Chip key={c.label} tone={c.tone}>{c.label}</Chip>)}
        </div>
        <p className="sec-t">Объект: один чип этапа конвейера</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {STAGE_CHIPS.map((c) => <Chip key={c.label} tone={c.tone}>{c.label}</Chip>)}
        </div>
        <p className="sec-t">Все девять тонов</p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(["neutral", "ok", "warn", "crit", "lime", "aqua", "lav", "sky", "pink"] as const).map((t) => (
            <Chip key={t} tone={t}>{t}</Chip>
          ))}
        </div>
        <div className="quiet">
          <span className="dot" />
          Чип клиента всегда действие, «горячий / холодный» только срез. «На сайте» это тихая точка, не чип.
        </div>
      </Card>

      <Card data-testid={id("filters-tabs")} title="Фильтры, вкладки, переключатель">
        <p className="sec-t" style={{ marginTop: 0 }}>Фильтры (40 px)</p>
        <Filters aria-label="Тип объекта" options={FILTERS} value={filter} onChange={setFilter} />
        <p className="sec-t">Вкладки внутри раздела</p>
        <Tabs aria-label="Срез клиентов" options={TABS} value={tab} onChange={setTab} />
        <p className="sec-t">Крупный переключатель (44)</p>
        <Segment aria-label="Кто" options={KINDS} value={kind} onChange={setKind} />
        <p className="sec-t">Три значения</p>
        <Segment
          aria-label="Период"
          value={tab}
          onChange={setTab}
          options={[
            { id: "work", label: "День" },
            { id: "idle", label: "Неделя" },
            { id: "lost", label: "Месяц" },
          ]}
        />
      </Card>

      <Card data-testid={id("list")} title="Карточка и список">
        <List aria-label="Сегодня">
          {CLIENTS.slice(0, 3).map((c) => (
            <Row
              key={c.name}
              avatar={c.avatar}
              title={c.name}
              line={c.line}
              chip={c.chip ? <Chip tone={c.chip.tone}>{c.chip.label}</Chip> : undefined}
              meta={c.meta}
            />
          ))}
        </List>
        <p className="sec-t">Строка нажимаема, действия справа не всплывают</p>
        <List aria-label="Нажимаемые строки">
          <Row
            avatar={CLIENTS[0].avatar}
            title={CLIENTS[0].name}
            line={CLIENTS[0].line}
            meta="14:00"
            onClick={() => setRowClicks((n) => n + 1)}
            actions={
              <>
                <Button variant="icon" aria-label="Написать" onClick={() => setActionClicks((n) => n + 1)}>
                  <MessageCircle size={18} aria-hidden />
                </Button>
                <Button variant="call" aria-label="Позвонить" onClick={() => setActionClicks((n) => n + 1)}>
                  <Phone size={18} aria-hidden />
                </Button>
              </>
            }
          />
          <Row avatar={CLIENTS[3].avatar} title={CLIENTS[3].name} line={CLIENTS[3].line} href="/dev/design-lab" done />
        </List>
        <div className="quiet" data-testid={id("row-counters")}>
          <span className="dot" />
          Нажатий на строку: {rowClicks}, на кнопки справа: {actionClicks}
        </div>
        <div className="quiet">
          <span className="dot" />
          Ещё 3 карточки не на виду: в корзине или ушли другому агенту
        </div>
      </Card>

      <Card data-testid={id("tiles")} title="Плитки">
        <Tiles>
          <Tile tone="lime" value={4} label="показа сегодня" />
          <Tile tone="aqua" value={2} label="новых лида" />
          <Tile tone="lav" value={3} label="ждут ответа" href="/dev/design-lab" />
        </Tiles>
        <p className="sec-t">Остальные тона</p>
        <Tiles>
          <Tile tone="sky" value={12} label="в подготовке" />
          <Tile tone="pink" value={1} label="сорван срок" />
          <Tile value="$48 тыс." label="без заливки" />
        </Tiles>
      </Card>

      <Card data-testid={id("skeleton")} title="Загрузка">
        <p className="sec-t" style={{ marginTop: 0 }}>Строка, линия, аватар, плитка</p>
        <Skeleton kind="row" />
        <Skeleton kind="row" />
        <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "12px 0" }}>
          <Skeleton kind="avatar" />
          <Skeleton width="50%" />
        </div>
        <Skeleton kind="tile" />
        <div className="quiet">
          <span className="dot" />
          Заглушки не мигают: бесконечных анимаций в контракте нет.
        </div>
      </Card>

      <Card data-testid={id("empty")} title="Пусто">
        <Rh2EmptyState
          icon={Inbox}
          title="Потерянных пока нет"
          hint="Сюда попадают клиенты без ответа дольше 14 дней."
          action={<Button size="sm" variant="soft">К клиентам</Button>}
        />
      </Card>

      <Card data-testid={id("sheet")} title="Шторка и подтверждение">
        <p style={{ margin: 0 }}>
          На телефоне окно становится шторкой снизу, на компьютере окном справа. Один корпус
          {" "}<code>Rh2Sheet</code>, подтверждение {" "}<code>ConfirmDialog</code> стоит на нём же.
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 }}>
          <Button variant="soft" onClick={() => setSheetOpen(true)}>Передать клиента</Button>
          <Button variant="danger" onClick={() => setConfirm("danger")}>Удалить (необратимо)</Button>
          <Button variant="ghost" onClick={() => setConfirm("plain")}>Подтвердить (обычное)</Button>
          <Button variant="ghost" onClick={() => setConfirm("blocked")}>Кнопка с причиной</Button>
        </div>
      </Card>

      <Rh2Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Передать клиента"
        footer={
          <>
            <Button variant="ghost" onClick={() => setSheetOpen(false)}>Отмена</Button>
            <Button onClick={() => setSheetOpen(false)}>Передать</Button>
          </>
        }
      >
        <p>Фаррух Назаров уйдёт к другому агенту вместе с историей и записями звонков.</p>
      </Rh2Sheet>

      {confirm === "danger" && (
        <ConfirmDialog
          title="Удалить клиента?"
          description="Карточка, история и записи звонков удалятся без возможности восстановить."
          confirmLabel="Удалить"
          onConfirm={() => setConfirm(null)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "plain" && (
        <ConfirmDialog
          title="Опубликовать 3 объекта?"
          description="Объекты появятся на сайте сразу после подтверждения."
          confirmLabel="Опубликовать"
          danger={false}
          onConfirm={() => setConfirm(null)}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === "blocked" && (
        <ConfirmDialog
          title="Вернуть монтажёру?"
          description="Ролик уйдёт обратно на доработку."
          confirmLabel="Вернуть"
          danger={false}
          confirmDisabled
          confirmHint="Загрузите исходник, без него вернуть нельзя"
          onConfirm={() => setConfirm(null)}
          onCancel={() => setConfirm(null)}
        />
      )}
    </>
  );
}

function ClientsScreen() {
  const [tab, setTab] = useState<TabId>("work");
  const [kind, setKind] = useState<KindId>("buyers");
  return (
    <>
      <Segment aria-label="Кто" options={KINDS} value={kind} onChange={setKind} />
      <Tabs aria-label="Срез клиентов" options={TABS} value={tab} onChange={setTab} />
      <Card tight>
        <List>
          {CLIENTS.map((c) => (
            <Row
              key={c.name}
              avatar={c.avatar}
              title={c.name}
              line={c.line}
              chip={c.chip ? <Chip tone={c.chip.tone}>{c.chip.label}</Chip> : undefined}
              meta={c.meta}
              href="/dev/design-lab"
              actions={
                <>
                  <Button variant="icon" aria-label={`Написать: ${c.name}`}><MessageCircle size={18} aria-hidden /></Button>
                  <Button variant="call" aria-label={`Позвонить: ${c.name}`}><Phone size={18} aria-hidden /></Button>
                </>
              }
            />
          ))}
        </List>
        <div className="quiet"><span className="dot" />Не на виду: 3 карточки</div>
      </Card>
    </>
  );
}
