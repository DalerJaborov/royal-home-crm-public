import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MoreHorizontal, ShieldAlert, Sparkles } from "lucide-react";
import { buildPultView, pluralizeRu, type PultArea } from "@royal-home/shared";
import { useCan } from "../../lib/permissions";
import { dushanbeDate, dushanbeHour } from "../../lib/date";
import { useAuthStore } from "../../store/auth";
import { useMobileUx } from "../../hooks/useMobileUx";
import { mcOk, useMissionControl, type MissionControlData } from "../../hooks/useMissionControl";
import { useBotTrainerQueue } from "../../hooks/useBotTrainer";
import { Button, LinkButton } from "../rh2/Button";
import { Card } from "../rh2/Card";
import { Chip } from "../rh2/Chip";
import { Filters, type FilterOption } from "../rh2/Filters";
import { PageHeader } from "../rh2/PageHeader";
import { Rh2ErrorState } from "../rh2/Rh2ErrorState";
import { Rh2Screen } from "../rh2/Rh2Screen";
import { Rh2Inline } from "../rh2/Rh2Scope";
import { Rh2Sheet } from "../rh2/Rh2Sheet";
import { List, Row } from "../rh2/Row";
import { Skeleton } from "../rh2/Skeleton";
import { Tile, Tiles } from "../rh2/Tile";
import { BotTrainer } from "../trainer/BotTrainer";
import { ActionRowList } from "./ActionRow";
import { DirectorAskSheet } from "./DirectorAskSheet";
import { MorningBriefingCard } from "./MorningBriefingCard";
import { usePultActionRows } from "./PultActions";

/**
 * ПУЛЬТ ДИРЕКТОРА И АДМИНИСТРАТОРА, ОДИН ЭКРАН НА ПК И ТЕЛЕФОНЕ (контракт
 * 06.10.2026, раздел 7; решение владельца: админ видит то же, что директор).
 *
 * ЗАМЕНИЛ три экрана: пульт ПК (`pages/MissionControl.tsx` с героем, лентой
 * событий и восемью разделами компании) и мобильную главную
 * (отдельная мобильная главная директора). Замер «до» (docs/design/parity/2026-10-06-homes):
 * телефон показывал 14 % содержимого ПК и ни одной кнопки решения. Теперь
 * по смыслу экран один: «Ждут вас» с кнопкой на каждое решение, три плитки
 * проблем, три свёрнутые строки. Подробности разделов открываются в самих
 * разделах: лента разделов (только ПК) и таббар с «Ещё» ведут туда.
 *
 * ДАННЫЕ. Тот же снимок `/dashboard/mission-control` и тот же `buildPultView`,
 * что кормили пульт, решения те же (`usePultActionRows`: сделки, материалы,
 * передача клиентов, ошибки системы, вопросы ИИ). Новых запросов нет. Блок, под
 * который сервер не отдал данные (модуль выключен, раздел снимка не пришёл),
 * не рисуется вовсе: числа руководителю не выдумываем.
 */

const SECTION_COUNT_RE = /^(\d[\d\s]{0,4})(?:\D|$)/;

/** Число-суть раздела для ленты: только короткое число из начала `big` («12 в продаже» → 12). */
function stripCount(big: string): number | undefined {
  const t = big.trim();
  if (!t || /нет данных/i.test(t)) return undefined;
  const m = SECTION_COUNT_RE.exec(t);
  if (!m) return undefined;
  const digits = m[1].replace(/\s/g, "");
  return digits.length <= 4 ? Number(digits) : undefined;
}

function sectionOptions(areas: PultArea[]): FilterOption[] {
  return areas.map((a) => ({
    id: a.id,
    label: a.label,
    count: stripCount(a.big),
    tone: a.tone === "ok" ? undefined : a.tone,
  }));
}

/** Свёрнутые строки пульта: вся строка кнопка (растянутая ссылка `Row`), справа шеврон вместо слова «развернуть». */
const CHEVRON = <ChevronRight className="i" aria-hidden />;

type OpenSheet = "ask" | "more" | "discuss" | "candidates" | "system" | null;

export function DirectorHome() {
  const can = useCan();
  const navigate = useNavigate();
  const mobile = useMobileUx();
  const qc = useQueryClient();
  const canView = can("dashboard.analytics");
  const canTrainer = can("settings.manage");
  const agent = useAuthStore((s) => s.agent);
  const firstName = agent?.fullName?.split(" ")[0] ?? "";
  const { data, isLoading, isError, error, isFetching } = useMissionControl(canView);
  const rows = usePultActionRows(canView);
  const view = useMemo(() => (data ? buildPultView(data, dushanbeHour()) : null), [data]);
  const [open, setOpen] = useState<OpenSheet>(null);
  const [waiting, setWaiting] = useState<number | null>(null);
  const trainerQueue = useBotTrainerQueue({ enabled: canTrainer });

  const title = `Здравствуйте${firstName ? `, ${firstName}` : ""}`;
  const today = dushanbeDate(new Date(), { weekday: "long", day: "numeric", month: "long" });
  const sub =
    waiting === null
      ? today
      : `${today} · ${waiting === 0 ? "ждать нечего" : `ждут вас ${waiting} ${pluralizeRu(waiting, ["решение", "решения", "решений"])}`}`;

  // Две круглые кнопки шапки телефона и те же две на ПК: ИИ и «Ещё». Один узел,
  // чтобы шапка оболочки не перерисовывалась на каждом опросе пульта.
  const headerButtons = useMemo(
    () => (
      <>
        <Button variant="icon" aria-label="Спросить ИИ" onClick={() => setOpen("ask")}>
          <Sparkles className="i" aria-hidden />
        </Button>
        <Button variant="icon" aria-label="Ещё" onClick={() => setOpen("more")}>
          <MoreHorizontal className="i" aria-hidden />
        </Button>
      </>
    ),
    [],
  );
  // Шапка оболочки стоит вне области `.rh2 .scr`, где живёт облик набора, поэтому
  // кнопки для неё обёрнуты в `Rh2Inline`: без него это были бы голые кнопки браузера.
  const shellButtons = useMemo(
    () => (
      <Rh2Inline>
        <div className="flex items-center gap-2">{headerButtons}</div>
      </Rh2Inline>
    ),
    [headerButtons],
  );

  if (!canView) {
    return (
      <Rh2Screen title={title}>
        <Card tight>
          <p className="quiet">Раздел доступен только руководству.</p>
        </Card>
      </Rh2Screen>
    );
  }

  const system = data?.system && mcOk(data.system) ? data.system : null;
  const control = system?.control ?? null;
  const firstLine = data?.firstLine && mcOk(data.firstLine) ? data.firstLine.items : [];
  const discuss = firstLine
    .filter((it) => !it.id.startsWith("owner-question-"))
    .sort((a, b) => rank(a.severity) - rank(b.severity));
  const cronsHealthy = system ? system.crons.filter((c) => c.healthy).length : 0;
  const allOk = !!system && cronsHealthy === system.crons.length && system.jobsGivenUp === 0;

  return (
    <Rh2Screen title={title} actions={shellButtons}>
      {/* На телефоне заголовок и кнопки стоят в шапке оболочки, а ленты разделов
          нет вовсе (разделы в таббаре и «Ещё»): ничего не рисуем, а не прячем,
          чтобы скрытый блок не сдвигал отступы `.scr>*+*`. */}
      {mobile ? null : (
        <>
          <PageHeader
            title={title}
            sub={sub}
            actions={
              <>
                <LinkButton to="/insights" variant="ghost" size="sm">
                  Разбор к собранию
                </LinkButton>
                {headerButtons}
              </>
            }
          />
          {view && view.areas.length > 0 ? (
            <Filters
              scroll
              aria-label="Разделы компании"
              options={sectionOptions(view.areas)}
              value=""
              onChange={(id) => {
                const area = view.areas.find((a) => a.id === id);
                if (area) navigate(area.href);
              }}
            />
          ) : null}
        </>
      )}

      {isError && !data ? (
        <Card tight>
          <Rh2ErrorState
            message={error instanceof Error ? error.message : "Пульт не загрузился, проверьте соединение."}
            onRetry={() => void qc.invalidateQueries({ queryKey: ["mission-control"] })}
            retrying={isFetching}
          />
        </Card>
      ) : isLoading || !data || !view ? (
        <Card tight aria-label="Загружаем пульт">
          <Skeleton kind="row" />
          <Skeleton kind="row" />
          <Skeleton kind="row" />
        </Card>
      ) : (
        <>
          {rows === null ? (
            <Card tight aria-label="Загружаем решения">
              <Skeleton kind="row" />
              <Skeleton kind="row" />
            </Card>
          ) : (
            <ActionRowList rows={rows} onCount={setWaiting} />
          )}

          {control ? (
            <Tiles>
              <Tile
                href="/oversight"
                tone={control.overdueTasks.count > 0 ? "pink" : "lime"}
                value={control.overdueTasks.count}
                label="просроченных задач"
              />
              <Tile
                href="/oversight"
                tone={control.atLimit.count > 0 ? "pink" : "aqua"}
                value={control.atLimit.count}
                label="на лимите нагрузки"
              />
              <Tile
                href="/oversight"
                tone={control.silentAfterShowing.count > 0 ? "pink" : "lime"}
                value={control.silentAfterShowing.count}
                label="без ответа после показа"
              />
            </Tiles>
          ) : null}

          <Card tight>
            <List aria-label="Ещё на пульте">
              <Row
                title={`Что стоит обсудить · ${discuss.length}`}
                line={discuss[0]?.text ?? "Замечаний к команде сегодня нет"}
                meta={CHEVRON}
                linkLabel={`Развернуть: Что стоит обсудить, ${discuss.length}`}
                onClick={() => setOpen("discuss")}
              />
              {system ? (
                <Row
                  title={`Кандидаты · ${system.newApplications} ${pluralizeRu(system.newApplications, ["новый", "новых", "новых"])}`}
                  meta={CHEVRON}
                  linkLabel="Развернуть: Кандидаты"
                  onClick={() => setOpen("candidates")}
                />
              ) : null}
              {system ? (
                <Row
                  title={`Система · ${allOk ? "всё работает" : "есть что проверить"}`}
                  line={`ошибок за сутки ${system.errorsToday}`}
                  meta={CHEVRON}
                  linkLabel="Развернуть: Система"
                  onClick={() => setOpen("system")}
                />
              ) : null}
            </List>
          </Card>
        </>
      )}

      {open === "ask" && view ? <DirectorAskSheet areas={view.areas} onClose={() => setOpen(null)} /> : null}

      {open === "discuss" ? (
        <Rh2Sheet title={`Что стоит обсудить · ${discuss.length}`} onClose={() => setOpen(null)}>
          {discuss.length === 0 ? (
            <p className="quiet ok">
              <i className="dot d-ok" aria-hidden="true" />
              Обсуждать нечего: замечаний к команде сегодня нет.
            </p>
          ) : (
            <List>
              {discuss.slice(0, 8).map((it) => (
                <Row
                  key={it.id}
                  className="wrapt"
                  title={it.text}
                  chip={it.severity === "critical" ? <Chip tone="crit">срочно</Chip> : undefined}
                  actions={
                    <LinkButton to={it.href} variant="ghost" size="sm">
                      Открыть
                    </LinkButton>
                  }
                />
              ))}
            </List>
          )}
        </Rh2Sheet>
      ) : null}

      {open === "candidates" && system ? (
        <Rh2Sheet title="Кандидаты" onClose={() => setOpen(null)}>
          <p className="quiet">
            <i className={`dot ${system.newApplications > 0 ? "d-warn" : "d-ok"}`} aria-hidden="true" />
            {system.newApplications} новых анкет
          </p>
          <div className="acts">
            <LinkButton to="/vacancies" size="sm">
              Открыть «Вакансии»
            </LinkButton>
          </div>
        </Rh2Sheet>
      ) : null}

      {open === "system" && system ? (
        <SystemSheet data={data} onClose={() => setOpen(null)} />
      ) : null}

      {open === "more" ? (
        <Rh2Sheet title="Ещё" onClose={() => setOpen(null)}>
          <List>
            <Row title="Разбор к собранию" line="вчерашний разбор ИИ" href="/insights" />
            <Row title="Настройки пульта" line="какие блоки показывать" href="/settings" />
          </List>
          {/* Брифинг и тренажёр бота ушли с главной сюда (контракт 06.10, п.6). */}
          <MorningBriefingCard enabled={canView} />
          {canTrainer ? (
            <Card tight title={`Тренажёр бота${trainerQueue.data ? ` · ${trainerQueue.data.total} ждут` : ""}`}>
              <BotTrainer compact />
            </Card>
          ) : null}
        </Rh2Sheet>
      ) : null}
      {/* Заголовок для скринридера: на телефоне видимый стоит в шапке оболочки. */}
      {mobile ? <h1 className="sr-only">{title}</h1> : null}
    </Rh2Screen>
  );
}

function rank(sev: "critical" | "warn" | "info"): number {
  return sev === "critical" ? 0 : sev === "warn" ? 1 : 2;
}

function SystemSheet({ data, onClose }: { data: MissionControlData | undefined; onClose: () => void }) {
  const s = data?.system && mcOk(data.system) ? data.system : null;
  if (!s) return null;
  const healthy = s.crons.filter((c) => c.healthy).length;
  return (
    <Rh2Sheet title="Система" onClose={onClose}>
      <List>
        <Row
          avatar={{ label: "К", tone: healthy === s.crons.length ? "lime" : "pink" }}
          title="Кроны"
          line={`${healthy} из ${s.crons.length} здоровы`}
        />
        <Row
          avatar={{ label: "Ф", tone: s.jobsGivenUp === 0 ? "lime" : "pink" }}
          title="Фоновые задачи"
          line={`${s.jobsRunning} в работе · ${s.jobsGivenUp} брошено`}
        />
        <Row
          avatar={{ label: "О", tone: s.errorsToday === 0 ? "lime" : "pink" }}
          title="Ошибки"
          line={`${s.errorsToday} за сегодня`}
        />
      </List>
      <div className="acts">
        <LinkButton to="/health" size="sm" variant="soft">
          Здоровье системы
        </LinkButton>
        <LinkButton to="/oversight" size="sm" variant="ghost">
          <ShieldAlert className="i" aria-hidden /> Контроль руководителя
        </LinkButton>
      </div>
    </Rh2Sheet>
  );
}
