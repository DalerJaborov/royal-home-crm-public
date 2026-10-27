import { Suspense, type ComponentProps } from "react";
import type { SettingsTabId } from "../../lib/settingsTabs";
import { CompanySection, DistrictsSection, LandmarksSection } from "../../pages/settings/AgencyTab";
import { CommissionSection, ExchangeRateSection } from "../../pages/settings/MoneyTab";
import { LeadsTab } from "../../pages/settings/LeadsTab";
import { MatchingTab } from "../../pages/settings/MatchingTab";
import { DisciplineSection } from "../../pages/settings/DisciplineTab";
import { AgentsSection, KpiWeightsSection, LeadDistributionSection, RoyalScoreEventsSection, RoyalScoreToggleSection } from "../../pages/settings/TeamTab";
import { ChannelsTab } from "../../pages/settings/ChannelsTab";
import { lazyWithReload } from "../../lib/lazyWithReload";
import { Skeleton } from "../rh2/Skeleton";
import { CustomerAgentRolloutSection } from "./CustomerAgentRolloutSection";
import {
  AssistantAuditSection,
  ImportSection,
  PasskeyToggleSection,
  ProblemReportsSection,
  StepUpSection,
  StuckConversationsSection,
  SystemHealthSection,
  SiteAdminSection,
} from "../../pages/settings/SystemTab";
import { PultModulesSection } from "../../pages/settings/PultModulesSection";
import { RestorePointsSection } from "../../pages/settings/RestorePointsSection";
import { SmsSection } from "../../pages/settings/SmsSection";
import { WhatsAppTemplatesSection } from "../../pages/settings/WhatsAppTemplatesSection";
import { SettingsGroupLabel } from "./SettingsSection";
import type { CleanSettingsTask } from "../../lib/cleanSettingsTasks";
import { UiShellRolloutSection } from "./UiShellRolloutSection";
import { SomonRecipientsSection } from "./SomonRecipientsSection";

// BotTab — 295 КБ (3,9 тыс. строк форм бота): грузим только когда открыта вкладка «Бот»,
// а не вместе со всеми Настройками. AiLearning импортирует его части напрямую — это отдельный маршрут.
const BotTabChunk = lazyWithReload(() => import("../../pages/settings/BotTab").then((m) => ({ default: m.BotTab })));

function BotTab(props: ComponentProps<typeof BotTabChunk>) {
  return (
    <Suspense fallback={<div role="status" aria-label="Загрузка настроек бота"><Skeleton className="h-4 w-48" /><Skeleton kind="tile" className="mt-3 h-24" /></div>}>
      <BotTabChunk {...props} />
    </Suspense>
  );
}

/** Same forms as legacy, composed by employee task rather than implementation history. */
export function CleanSettingsTaskContent({ task, agentRole }: { task: CleanSettingsTask; agentRole?: string }) {
  switch (`${task.tab}/${task.id}`) {
    case "agency/company": return <CompanySection />;
    case "agency/locations": return <><DistrictsSection /><LandmarksSection /></>;
    case "money/commission": return <CommissionSection part="commission" />;
    case "money/currency": return <ExchangeRateSection />;
    case "leads/intake": return <LeadsTab limitsTask />;
    case "leads/distribution": return <><LeadDistributionSection /><SomonRecipientsSection /></>;
    case "leads/deadlines": return <><CommissionSection part="operations" /><DisciplineSection /></>;
    case "matching/matching": return <MatchingTab />;
    case "team/people": return <AgentsSection />;
    case "team/rating": return <><RoyalScoreToggleSection /><KpiWeightsSection /><RoyalScoreEventsSection /></>;
    case "channels/messengers": return <><ChannelsTab area="messengers" /><WhatsAppTemplatesSection /></>;
    case "channels/publishing": return <ChannelsTab area="publishing" />;
    case "channels/advertising": return <ChannelsTab area="advertising" />;
    case "channels/phone": return <ChannelsTab area="phone" />;
    case "channels/sms": return <SmsSection />;
    case "bot/operation": return <BotTab area="operation" />;
    case "bot/answers": return <BotTab area="answers" />;
    case "bot/voice": return <BotTab area="voice" />;
    case "bot/learning": return <BotTab area="learning" />;
    case "bot/models": return <BotTab area="models" />;
    case "bot/rollout": return agentRole === "DIRECTOR" || agentRole === "ADMIN" ? <CustomerAgentRolloutSection /> : null;
    case "system/monitoring": return <><SystemHealthSection /><AssistantAuditSection /><StuckConversationsSection /><ProblemReportsSection /></>;
    case "system/workspace": return <><UiShellRolloutSection /><PultModulesSection /></>;
    case "system/security": return <><StepUpSection /><PasskeyToggleSection /></>;
    case "system/data": return <><RestorePointsSection /><ImportSection /></>;
    case "system/website": return agentRole === "DIRECTOR" ? <SiteAdminSection /> : null;
    default: return <p role="alert">Блок настроек не найден. Выберите другой блок выше.</p>;
  }
}

/**
 * Содержимое одной вкладки Настроек — вынесено из pages/Settings.tsx (14.09.2026),
 * чтобы тот же набор разделов, без потери ни одного, показывали обе ветки
 * разметки внутри Settings() — десктопная (`.sset-body`) и телефонная
 * (push-экран открытой вкладки). Состав и порядок разделов внутри каждой
 * вкладки не менялся — дословно то, что было веткой `tabContent` в
 * Settings.tsx до выноса.
 */
export function SettingsTabContent({ tab, agentRole }: { tab: SettingsTabId; agentRole: string | undefined }) {
  if (tab === "agency") {
    return (
      <>
        <CompanySection />
        <DistrictsSection />
        <LandmarksSection />
      </>
    );
  }

  if (tab === "money") {
    return (
      <>
        <CommissionSection />
        <ExchangeRateSection />
        <DisciplineSection />
      </>
    );
  }

  if (tab === "leads") return <LeadsTab />;

  if (tab === "matching") return <MatchingTab />;

  if (tab === "team") {
    return (
      <>
        <AgentsSection />
        <LeadDistributionSection />
        <SomonRecipientsSection />
        <RoyalScoreToggleSection />
        <KpiWeightsSection />
        <RoyalScoreEventsSection />
      </>
    );
  }

  if (tab === "channels") {
    return (
      <>
        <ChannelsTab />
        <WhatsAppTemplatesSection />
        <SettingsGroupLabel>СМС</SettingsGroupLabel>
        <SmsSection />
      </>
    );
  }

  if (tab === "bot") return <>
    {(agentRole === "DIRECTOR" || agentRole === "ADMIN") && <CustomerAgentRolloutSection />}
    <BotTab />
  </>;

  // tab === "system": восемь разделов подряд одним полотном было невозможно
  // окинуть взглядом (жалоба владельца 19.08.2026 — «чёрт ногу сломит»). Три
  // смысловые группы, как в Настройках телефона, каждый раздел сворачивается сам.
  return (
    <>
      <SettingsGroupLabel>Мониторинг</SettingsGroupLabel>
      <SystemHealthSection />
      <AssistantAuditSection />
      <PultModulesSection />
      <StuckConversationsSection />
      <ProblemReportsSection />

      <SettingsGroupLabel>Безопасность</SettingsGroupLabel>
      <StepUpSection />
      <PasskeyToggleSection />

      <SettingsGroupLabel>Данные</SettingsGroupLabel>
      <RestorePointsSection />
      <ImportSection />

      {/* Сброс пароля админки сайта — только владельцу компании. */}
      {agentRole === "DIRECTOR" && (
        <>
          <SettingsGroupLabel>Сайт</SettingsGroupLabel>
          <SiteAdminSection />
        </>
      )}
    </>
  );
}
