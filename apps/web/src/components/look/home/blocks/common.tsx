import { HomeAsk } from "../../../home/HomeAsk";
import { TeamCharts } from "../../../home/TeamCharts";
import { RhCircle, RhGroup, RhRow, RhSection } from "../../ui";
import type { HomeBlockProps } from "../core";

/**
 * ОБЩИЕ БЛОКИ ГЛАВНОЙ (ядро главной, пачка home, 20.11.2026): вопрос помощнику,
 * графики команды и рабочие разделы службы безопасности.
 */

/** Подсказки и подпись поля — свои у роли, как на прежних главных (макет `tpl-home-*`). */
const ASK: Record<string, { ariaLabel: string; placeholder: string; suggestions: string[] }> = {
  MARKETING: {
    ariaLabel: "Вопрос про конвейер и рекламу",
    placeholder: "Спросить: какие объекты застряли в подготовке?",
    suggestions: ["Какие объекты просрочены в подготовке?", "Что ждёт моей проверки?"],
  },
  default: {
    ariaLabel: "Вопрос про работу команды",
    placeholder: "Спросить: кто сейчас свободен для заявки?",
    suggestions: ["Кто сейчас свободен для заявки?", "Почему заявки висят дольше обычного?"],
  },
};

/** Вопрос помощнику — прежний HomeAsk (тот же POST /ai/assistant потоком; сервер режет ответ по роли). */
export function AskBlock({ role }: HomeBlockProps) {
  const ask = ASK[role] ?? ASK.default;
  return (
    <RhSection title="Спросить помощника" className="ry-col-b">
      <div className="ry-home-ask"><HomeAsk {...ask} /></div>
    </RhSection>
  );
}

/** Графики по команде — тот же TeamCharts (право dashboard.analytics проверяет он сам). */
export function ChartsBlock() {
  return <TeamCharts host="royal" />;
}

/**
 * Служба безопасности: прежняя главная роли — два перехода, «Клиенты» и «Объекты»
 * (pages/Dashboard.tsx, правка #66). Ни запросов, ни прав не прибавилось.
 */
export function SecurityLinks() {
  return (
    <RhSection title="Рабочие разделы">
      <nav aria-label="Доступные разделы">
        <RhGroup>
          <RhRow to="/clients" lead={<RhCircle icon="users" tone="a0" />} title="Клиенты" />
          <RhRow to="/properties" lead={<RhCircle icon="building-2" tone="a2" />} title="Объекты" />
        </RhGroup>
      </nav>
    </RhSection>
  );
}
