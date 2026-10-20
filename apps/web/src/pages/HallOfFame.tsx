import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useMyProfile } from "../hooks/useMe";
import { pluralizeRu } from "../lib/format";
import { Rh2Inline } from "../components/rh2/Rh2Scope";

interface Nominee {
  id: string;
  fullName: string;
  avatarUrl: string | null;
}

interface Nomination {
  key: string;
  title: string;
  unit: string;
  /** Что именно считается в номинации, чтобы не было споров «почему он лидер». */
  hint?: string;
  nominees: Nominee[];
}

export interface HallOfFameTeammate {
  id: string;
  fullName: string;
  avatarUrl: string | null;
  online: boolean;
}

interface HallOfFameData {
  month: string;
  team: HallOfFameTeammate[];
  nominations: Nomination[];
}

export function useHallOfFame() {
  return useQuery({
    queryKey: ["hall-of-fame"],
    queryFn: () => api<HallOfFameData>("/hall-of-fame"),
    refetchInterval: 5 * 60_000,
  });
}

export interface TopAgent {
  place: number;
  id: string;
  fullName: string;
  avatarUrl: string | null;
  /** null: счёт ещё ни разу не считался (новичок). */
  score: number | null;
  frozen: boolean;
  /** Закрытые сделки за текущий месяц. */
  dealsCount: number;
  /** % (сделки/лиды месяца); null: в этом месяце лидов ещё не было. */
  conversion: number | null;
  activeClients: number;
}

/**
 * Публичный рейтинг по Royal Score. Наружу идут место, имя, счёт и, по
 * спецификации владельца, сделки/конверсия/активные клиенты за месяц. НЕ разбор
 * по восьми показателям: почему у коллеги 82, его личное дело.
 */
export function useTopAgents() {
  return useQuery({
    queryKey: ["top-agents"],
    queryFn: () => api<{ agents: TopAgent[] }>("/hall-of-fame/top-agents"),
    refetchInterval: 5 * 60_000,
  });
}

const MONTHS = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/**
 * Доска почёта: лидеры текущего месяца по трём номинациям, видна всем сотрудникам.
 * Встраивается в раздел «Команда» (единая экосистема, см. Team.tsx).
 *
 * Разметка и подписи из утверждённого прототипа темы «Royal Home 2026»
 * (docs/pult/theme-2026/screens/team.html, блок «Доска почёта»): секция
 * `.sec` с `.sec-h`, карточки `.nom-c` в сетке `.nom`, строки `.nom-row`
 * с местом в `.pl` и именем в `.nmx`.
 *
 * Колонки `.val` (числовой результат номинанта) в разметке нет: GET
 * /hall-of-fame отдаёт только имя и аватар номинанта, самого числа в ответе
 * не существует, а выдумывать его нельзя.
 *
 * Класс `rh2` стоит на самой секции, а не отдельной обёрткой: блок встраивается
 * в «Команду» и на телефоне, и на ПК, оба родителя уже `.rh2`, — так эталон
 * включён и когда блок вставят в ещё не перенесённый экран.
 */
export function HallOfFameBoard() {
  const { data, isLoading, isError, refetch } = useHallOfFame();
  // data.month: душанбинская граница месяца (в UTC это 19:00 последнего дня
  // прошлого). getMonth() в поясе браузера западнее UTC+5 показывал ПРОШЛЫЙ
  // месяц («июль» для августовской доски). Читаем месяц в поясе Душанбе.
  const monthName = data
    ? MONTHS[Number(new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Dushanbe", month: "numeric" }).format(new Date(data.month))) - 1]
    : null;

  return (
    <Rh2Inline>
      <div className="sec">
        <div className="sec-h">
          <h2>Доска почёта</h2>
          <span className="note">
            {monthName ? `номинанты за ${monthName}, пересобираются 1 числа` : "номинанты текущего месяца, пересобираются 1 числа"}
          </span>
        </div>

        {/* Отказ не равен пустоте (26.08.2026): раньше и загрузка, и отказ сервера
            выглядели одинаково, заголовок и пустота, без намёка, что пошло не так. */}
        {isLoading && (
          <div className="card tight">
            <div className="state">
              <span className="sk av" />
              <span className="sk w28" />
              <span className="sk w22" /> Загружаем номинации
            </div>
          </div>
        )}
        {isError && (
          <div className="card tight">
            <div className="state err">
              <span className="dot crit" /> Доска почёта не загрузилась. Это сбой связи, а не пустой месяц.{" "}
              <button
                className="lk"
                type="button"
                style={{ color: "inherit", textDecoration: "underline" }}
                onClick={() => refetch()}
              >
                Повторить
              </button>
            </div>
          </div>
        )}

        <div className="nom">
          {data?.nominations.map((n) => (
            <article className="nom-c" key={n.key}>
              <span className="eyebrow">Номинация</span>
              <h3>{n.title}</h3>
              {n.hint && <p className="hint">{n.hint}</p>}
              {n.nominees.length === 0 ? (
                <p className="state">В этом месяце результатов пока нет, всё впереди.</p>
              ) : (
                n.nominees.map((nom, i) => (
                  <div className={i === 0 ? "nom-row first" : "nom-row"} key={nom.id}>
                    <span className="pl">{i + 1}</span>
                    <span className="nmx" title={nom.fullName}>{nom.fullName}</span>
                  </div>
                ))
              )}
            </article>
          ))}
        </div>
      </div>
    </Rh2Inline>
  );
}

/**
 * Royal Score: публичный рейтинг.
 *
 * Отдельно от доски почёта нарочно: доска про месяц и три номинации («лучший
 * продажник»), рейтинг про текущий счёт целиком. Свалив их вместе, мы получили
 * бы экран, где непонятно, за какой период считается что.
 *
 * Замороженные остаются в списке с пометкой: заморозка это остановка работы, а
 * не удаление человека из рейтинга.
 *
 * Разметка прототипа: `.sec` + `.card.tight`, строки `.rank` с местом `.pl`,
 * именем `.t`, числами `.nums` и своей строкой под классом `.rank.me`.
 */
export function TopAgentsBoard() {
  const { data } = useTopAgents();
  const { data: me } = useMyProfile();
  if (!data || data.agents.length === 0) return null;

  // Колонка «место N из 8» (полный рейтинг) только директору (штурм 2.7,
  // layer-3-plan §5 C4.1: «место N из 8 только директору»). Остальные роли
  // (включая ADMIN/MANAGER) видят в этом блоке только свою строку, без
  // сравнения с коллегами по позиции в списке.
  const isDirector = me?.role === "DIRECTOR";
  const rows = isDirector ? data.agents : data.agents.filter((a) => a.id === me?.id);
  if (rows.length === 0) return null;

  return (
    <Rh2Inline>
      <div className="sec">
        <div className="sec-h">
          <h2>Royal Score</h2>
          <span className="note">счёт считает CRM сама, вручную не меняется</span>
        </div>
        <div className="card tight">
          <p className="state">
            {isDirector
              ? "Полный список открыт директору. Разбор по показателям виден только самому агенту в его профиле."
              : `Ваш текущий счёт${data.agents.length > 1 ? `, из ${data.agents.length}` : ""}. Место и счёт коллег видит только директор.`}
          </p>
          {rows.map((a) => (
            <div className={a.id === me?.id ? "rank me" : "rank"} key={a.id}>
              {isDirector && <span className="pl">{a.place}</span>}
              <span className="t">
                {a.fullName}
                {a.id === me?.id && <span className="chip mute">вы</span>}
                {a.frozen && <span className="chip warn">заморожен</span>}
              </span>
              <span className="nums">
                <span>
                  <b>{a.dealsCount}</b> {pluralizeRu(a.dealsCount, ["сделка", "сделки", "сделок"])}
                </span>
                <span>
                  <b>{a.conversion !== null ? a.conversion : "нет"}</b> % конверсия
                </span>
                <span>
                  <b>{a.activeClients}</b> {pluralizeRu(a.activeClients, ["клиент", "клиента", "клиентов"])}
                </span>
                <span>
                  <b>{a.score ?? "нет"}</b> счёт
                </span>
              </span>
            </div>
          ))}
        </div>
      </div>
    </Rh2Inline>
  );
}
