import { GraduationCap, HelpCircle, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useCan } from "../lib/permissions";
import { BotQuestionsSection, BotLessonsSection, LostClientsSection } from "./settings/BotTab";
import { BotAuditSection } from "../components/BotAuditSection";
import { DistillNowButton } from "../components/DistillNowButton";
import { GuardStatsPanel, PendingCasesPanel, SavedTrainingSamplesSection, TrainingSession } from "../components/BotTrainingPanels";
import { BotTrainer } from "../components/trainer/BotTrainer";
import { useBotLearning } from "../hooks/useBotLearning";
import { useBotAuditList } from "../hooks/useBotAudit";
import { useSettings } from "../hooks/useSettings";
import { StatTile } from "../components/ui/StatTile";

function scrollTo(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * «Обучение бота» — ОДИН экран (слияние 15.09.2026, решение владельца: «я не
 * понял, как оно вообще должно работать»). Раньше здесь были два отдельных
 * пункта меню — «Обучение ИИ» (/ai-learning) и «Тренировка» (/bot-training) —
 * оба про «сотрудник поправил бота», но пишущие в РАЗНЫЕ таблицы разными
 * механизмами, и по интерфейсу это было не понять:
 *
 *  - «Правила» — ЧТО говорить. Правила вида «спрашивают про X, отвечай Y»,
 *    выведенные из разговоров ботом или дописанные вручную, подмешиваются в
 *    промт как `learnedRulesBlock` (apps/api/src/lib/botLessons.ts).
 *  - «Манера» — КАК говорить. Примеры тона (StyleExample), подмешиваются в
 *    промт как образцы манеры (apps/api/src/ai/styleLearning.ts), а не как
 *    готовые ответы.
 *
 * Ни таблицы, ни оба механизма подмешивания не тронуты — это перекладка
 * интерфейса, а не переделка обучения. Раздел «Тренировка» (сама тренировка —
 * показать вопрос клиента, выбрать лучший ответ или вписать свой) остался
 * работать ровно как раньше, теперь внутри вкладки «Манера».
 *
 * Вкладки — ВНУТРИ ЭКРАНА (query-параметр ?tab=, идиома pages/Settings.tsx +
 * lib/settingsTabs.ts), а не пункты общего меню (components/ScreenTabs.tsx):
 * там вкладка — это ссылка на ДРУГОЙ экран, здесь все разделы живут на одном
 * URL и делят один запрос прав. Маршрут /bot-training больше не
 * отдельный экран — редирект на /ai-learning?tab=manner (App.tsx), чтобы
 * старые ссылки и закладки не ломались.
 *
 * ПРАВА. Оба бывших экрана требовали одно и то же право (`settings.view`) —
 * конфликта прав между вкладками нет, отдельно проверять на каждой не нужно.
 *
 * ОДИН ЭКРАН НА ОБЕ ШИРИНЫ: мобильных копий не было ни у одного из двух
 * экранов (сведено 10.09.2026) — узкую раскладку и так делают медиазапросы
 * темы внутри самих секций; то же верно для BotTrainer (переключатель
 * очередь/переписка на ≤980px — в самом компоненте).
 *
 * ТРИ ПЛИТКИ СВЕРХУ (владелец 17.09.2026: «пагинации нет, и как-то бардак») —
 * числа, по которым раньше приходилось листать всю страницу, теперь наверху и
 * кликабельны. Клик по плитке переключает на вкладку, где живёт нужная
 * секция, и подскролливает к ней (см. `goTo`) — секции «Вопросы»/«Правила»
 * обе живут во вкладке «rules», «Находки судьи» — во вкладке «audit».
 *
 * 17.09.2026 (тренажёр бота, сведено с main 18.09.2026 при слиянии #482/#487/
 * #490): «Тренажёр» — новая ПЕРВАЯ вкладка (владелец: «одна переписка — одно
 * решение», см. компонент BotTrainer) — теперь и вход по умолчанию (пустой
 * `?tab=` открывает её, а не «Правила»). Остальные четыре вкладки — дословно
 * как в main, имена и id НЕ переименованы («rules», не «lists») — `goTo` и
 * якоря плиток ссылаются на них по этим именам, переименование сломало бы их.
 */
type LearningTab = "trainer" | "rules" | "manner" | "lost" | "audit";

const TABS: { id: LearningTab; label: string }[] = [
  { id: "trainer", label: "Тренажёр" },
  { id: "rules", label: "Правила" },
  { id: "manner", label: "Манера" },
  { id: "lost", label: "Куда уходят клиенты" },
  { id: "audit", label: "Аудит диалогов" },
];

function isLearningTab(value: string | null): value is LearningTab {
  return TABS.some((t) => t.id === value);
}

export function AiLearning() {
  const can = useCan();
  const canView = can("settings.view");
  // Предупреждение сверху (макет) — счётчик вопросов, на которые бот ждёт
  // подсказку, честный (data.questionsTotal, тот же источник, что и у секции
  // «Бот спрашивает» ниже). Хук зовём до ранних возвратов (правило хуков).
  const learning = useBotLearning({ enabled: canView });
  // Третья плитка — «Находки судьи не разобраны» — тот же источник, что и
  // счётчик внутри BotAuditSection (useBotAuditList, общий react-query кэш):
  // два места читают одно значение, а не считают его отдельно и не расходятся.
  const audit = useBotAuditList();
  const { data: settings, isLoading: settingsLoading } = useSettings();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get("tab");
  // Пустой параметр открывает «Тренажёр» (новый вход по умолчанию, 17.09.2026) —
  // «Правила» больше не тот же самый URL, что и без параметра, а обычная
  // вкладка со своим ?tab=rules, как и остальные три.
  const tab: LearningTab = isLearningTab(rawTab) ? rawTab : "trainer";

  function choose(next: LearningTab) {
    setSearchParams(next === "trainer" ? {} : { tab: next }, { replace: true });
  }

  // Плитка может указывать на секцию с ДРУГОЙ вкладки (например, «Находки
  // судьи» живёт на вкладке «audit», а сейчас открыта «rules») — тогда сперва
  // переключаем вкладку и ждём её собственного рендера (эффект ниже), и
  // только потом скроллим; если вкладка уже та, скроллим сразу.
  const [pendingScroll, setPendingScroll] = useState<string | null>(null);
  useEffect(() => {
    if (!pendingScroll) return;
    scrollTo(pendingScroll);
    setPendingScroll(null);
  }, [tab, pendingScroll]);

  function goTo(nextTab: LearningTab, id: string) {
    if (tab === nextTab) {
      scrollTo(id);
    } else {
      setPendingScroll(id);
      choose(nextTab);
    }
  }

  if (!canView) {
    return (
      <div className="rh2 screens">
        <div className="scr">
          <div className="pg-h">
            <div>
              <h1>Обучение бота</h1>
            </div>
          </div>
          <div className="card tight">
            <div className="empty">
              <span className="ic">
                <GraduationCap className="i" aria-hidden />
              </span>
              <p>Этот раздел доступен только тем, у кого есть право на настройки.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const data = learning.data;
  const canDecideTraining = can("settings.manage");

  return (
    <div className="rh2 screens">
      <div className="scr">
        <div className="pg-h">
          <div>
            <h1>Обучение бота</h1>
            {/* Честная строка простыми словами (главная жалоба владельца —
                непонятно, как это вообще работает): что это, откуда берутся
                записи и что изменится в ответах бота после действия человека. */}
            <p className="sub">
              Здесь бот учится у людей. «Тренажёр» — самый быстрый способ: одна переписка, одно решение,
              применяется сразу. «Правила» и «Манера» — то же самое, но целиком и руками: это то, что бот
              подхватил из живых переписок или из вашей правки. «Куда уходят клиенты» и «Аудит диалогов» — как
              проверить, что из этого вышло.
            </p>
          </div>
          <div className="acts">
            <DistillNowButton />
          </div>
        </div>

        {/*
         * Три плитки-сводки (владелец 17.09.2026: «пагинации нет, и как-то
         * бардак» — числа, по которым раньше приходилось листать всю страницу,
         * теперь наверху и кликабельны). Честная замена «Правил действует: 112
         * из 112»: средняя плитка — не «включено», а СКОЛЬКО РЕАЛЬНО уходит в
         * промт (promptCount/promptLimit, тот же отбор, что видит бот —
         * selectActiveLessons на сервере, см. lib/botLessons.ts).
         *
         * Первая плитка — число УНИКАЛЬНЫХ групп (18.09.2026, доделка:
         * questionsTotal считает сырые случаи, и один и тот же вопрос от
         * разных клиентов раздувал бы плитку сильнее, чем реально нужно
         * ответов). Сырое число — рядом в скобках, честно, не спрятано.
         */}
        <div className="tiles">
          <StatTile
            icon={HelpCircle}
            label="Ждут подсказки"
            value={data ? data.questionsGroupsTotal : "…"}
            line={data ? `разных вопросов (случаев — ${data.questionsTotal})` : "разговоров бот не понял"}
            critical={!!data && data.questionsGroupsTotal > 0}
            onClick={() => goTo("rules", "ai-learning-questions")}
            title="Список вопросов ниже, во вкладке «Правила»"
          />
          <StatTile
            icon={GraduationCap}
            label="В промте"
            value={data ? `${data.promptCount} из ${data.rulesGroupsTotal}` : "…"}
            line={data ? `включённых — ${data.activeCount}, потолок промта — ${data.promptLimit}` : undefined}
            onClick={() => goTo("rules", "ai-learning-lessons")}
            title="Список правил ниже, во вкладке «Правила»"
          />
          <StatTile
            icon={ShieldAlert}
            label="Находки судьи не разобраны"
            value={audit.data ? audit.data.unresolvedTotal : "…"}
            line="за случайные переписки"
            critical={!!audit.data && audit.data.unresolvedTotal > 0}
            onClick={() => goTo("audit", "ai-learning-audit")}
            title="Находки судьи во вкладке «Аудит диалогов»"
          />
        </div>

        <div className="hscroll">
          <div className="seg" role="tablist" aria-label="Разделы обучения бота">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => choose(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {tab === "trainer" && <BotTrainer />}

        {tab === "rules" && (
          <>
            {/* Предупреждение сверху (макет, tpl-ai-learning). Первая строка —
                «крон разбирает раз в два часа, последний раз в HH:MM, выведено N
                правил» — честно построить нельзя: сервер не хранит время
                последнего запуска крона и не хранит, сколько правил вывела ИМЕННО
                последняя сборка (только когда создано КАЖДОЕ правило по
                отдельности, data.rules[].createdAt). Показываем то, что реально
                есть: сколько правил действует всего. Вторая строка — честная,
                questionsTotal тот же источник, что у секции «Бот спрашивает». */}
            {data && (
              <div className="card tight">
                <div className="quiet">
                  <span className="dot ok" />
                  <span className="txt">
                    Правил действует: {data.activeCount} из {data.rulesTotal}.
                  </span>
                </div>
                {data.questionsTotal > 0 && (
                  <div className="quiet warn">
                    <span className="dot warn" />
                    <span className="txt">
                      {data.questionsTotal} {data.questionsTotal === 1 ? "разговор" : "разговора"} бот не понял, и
                      правила из {data.questionsTotal === 1 ? "него" : "них"} не вывелось. Он ждёт вашей подсказки.
                    </span>
                  </div>
                )}
              </div>
            )}

            {/* Порядок — как владельцу нужно действовать (17.09.2026): сперва то,
                где его ввод сразу даёт правило, потом то, чему бот уже научился
                сам. Открыта по умолчанию только секция вопросов. */}
            <div id="ai-learning-questions">
              <BotQuestionsSection />
            </div>
            <div id="ai-learning-lessons">
              <BotLessonsSection />
            </div>
          </>
        )}

        {tab === "manner" && (
          <>
            {settingsLoading ? (
              <div className="card tight">
                <div className="state">
                  <span className="sk w28" />
                  <span className="sk w22" /> Загружаем настройки
                </div>
              </div>
            ) : !settings?.botTrainingScreenEnabled ? (
              // Рубильник (Настройки → Бот → «Тренировка ответов»). Проверка и на сервере —
              // тумблер здесь защищает от случайного захода по прямой ссылке, а не подменяет
              // серверный отказ 403 у /bot-training/next и /bot-training/decide. Счётчики
              // фильтров ниже от этого рубильника не зависят — эндпоинт открыт отдельно
              // (сохранено то же поведение, что было до переноса облика).
              <div className="card tight">
                <div className="quiet warn">
                  <span className="dot warn" />
                  <span className="txt">Экран выключен в настройках: тренировать сейчас нельзя, вопросы копятся.</span>
                  {can("settings.manage") && (
                    <Link className="lnk" to="/settings?tab=bot">
                      Включить в настройках
                    </Link>
                  )}
                </div>
              </div>
            ) : (
              <>
                <PendingCasesPanel />
                <TrainingSession canDecide={canDecideTraining} />
                <SavedTrainingSamplesSection />
              </>
            )}

            <GuardStatsPanel />
          </>
        )}

        {tab === "lost" && <LostClientsSection />}

        {tab === "audit" && (
          <div id="ai-learning-audit">
            <BotAuditSection />
          </div>
        )}
      </div>
    </div>
  );
}
