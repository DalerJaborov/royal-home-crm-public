import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { MissionControlData } from "../../hooks/useMissionControl";
import { isSettingsTabId } from "../../lib/settingsTabs";
import { allowedQueueHref, buildCleanWorkQueues, CleanWorkQueues } from "./CleanWorkQueues";

const base: MissionControlData = { generatedAt: "2026-10-09T08:00:00Z", seesMoney: false, modulesOff: [], hero: { error: true } };
const bot: NonNullable<MissionControlData["bot"]> = {
  ai: { requestsToday: 0, errorsToday: 0, errorRatePercent: 0, costUsdToday: null, avgMs: 0 }, guardHitsToday: 0, outboundShieldToday: 0, unresolvedFindings: null,
  attention: { liveCount: 1, silent: { count: 0, items: [], reason: null }, waitingHuman: { count: 7, reason: null, items: [{ id: "dialog-1", kind: "TELEGRAM", channel: "TELEGRAM", title: "Ждёт агента", clientId: null, lastMessageAt: base.generatedAt, waitingMinutes: 15 }] } },
};

describe("clean work queues", () => {
  it("validates internal deep links against their actual registry section", () => {
    const allowed = (path: string) => path === "/clients";
    expect(allowedQueueHref("/clients/42?tab=activity#last", allowed)).toBe("/clients/42?tab=activity#last");
    for (const value of ["//example.com", "https://example.com", "/clients/../settings", "/clients/%2e%2e/settings", "/clients\\evil", "/settings?tab=channels", "/clients/42\n"])
      expect(allowedQueueHref(value, allowed)).toBeUndefined();
  });

  it("uses the existing Telegram inbox contract and labels a partial server queue honestly", () => {
    const data = { ...base, bot };
    const html = renderToStaticMarkup(<MemoryRouter><CleanWorkQueues data={data} allowedRoute={(path) => path === "/messages"} /></MemoryRouter>);
    expect(html).toContain('href="/messages?open=tg_dialog-1"');
    expect(html).toContain("Доступных строк показано 1 из 7");
    expect(html).toContain("ждёт 15 мин");
    expect(html).not.toContain("Диалоги без ответа");
  });

  it("does not expose failed, disabled, forbidden or zero-only panels", () => {
    expect(buildCleanWorkQueues({ ...base, bot }, () => false)).toEqual([]);
    expect(buildCleanWorkQueues({ ...base, bot, modulesOff: ["bot"] }, () => true)).toEqual([]);
    expect(buildCleanWorkQueues({ ...base, bot: { error: true }, video: { pipeline: { total: 0, awaitingReview: 0, awaitingPhotos: 0, awaitingVideo: 0, editing: 0, overdue: 0 } } }, () => true)).toEqual([]);
  });

  it("preserves live call data without granting client navigation and preserves explicit lead pause", () => {
    const data: MissionControlData = { ...base,
      calls: { live: { incoming: [{ channelId: "call-1", clientName: "Клиент", clientShortId: 42, answered: false, seconds: 12 }], outgoing: [] }, today: { incoming: 3, outgoing: 2, missed: 1, unqualified: 0 } },
      team: { agents: [{ id: "agent-1", fullName: "Агент", avatarUrl: null, activeLoad: 6, pendingAccept: 2, acceptedToday: 1, buyerCount: 4, sellerCount: 2, takesLeads: false }] },
    };
    const queues = buildCleanWorkQueues(data, (path) => path === "/calls" || path === "/team");
    expect(queues[0].rows[0].href).toBeUndefined();
    expect(queues[0].rows[0].detail).toBe("Ожидает ответа · 12 с");
    expect(queues[0].detail).toContain("пропущенных 1");
    expect(queues[1].rows[0].detail).toContain("приём лидов на паузе");
    expect(queues[1].rows[0].detail).toContain("ждут принятия 2");
    expect(queues[1].rows[0].href).toBe("/team/agent-1");
  });

  it("keeps a real channel error visible even when no channel rows were returned", () => {
    expect(isSettingsTabId("channels")).toBe(true);
    const data: MissionControlData = { ...base, marketing: { instagramCommentsWaiting: 0, funnel: [], funnelMonth: "2026-10", channels: { reason: null, items: [], connectedCount: 0, openErrors: 3, autoPublishEnabled: false } } };
    const html = renderToStaticMarkup(<MemoryRouter><CleanWorkQueues data={data} allowedRoute={(path) => path === "/settings"} /></MemoryRouter>);
    expect(html).toContain("открытых ошибок 3");
    expect(html).toContain('href="/settings?tab=channels"');
    expect(html).not.toContain("Доступных строк показано");
  });

  it("keeps channel metrics in closed details and gates every monetary field", () => {
    const marketing: NonNullable<MissionControlData["marketing"]> = { instagramCommentsWaiting: 0, funnelMonth: "2026-10", funnel: [{ source: "INSTAGRAM", label: "Instagram", leadsMonth: 18, showingsMonth: 4, dealsClosedMonth: 2, spendMonthTjs: 987, commissionMonthTjs: 4567, costPerLeadTjs: 54, leadsToday: 1, leadsTrailing7Avg: 3, anomalyLeadsDown: true }] };
    const allowed = (path: string) => path === "/sources";
    const privateData = { ...base, marketing };
    const privateRow = buildCleanWorkQueues(privateData, allowed)[0].rows[0];
    expect(privateRow.detail).toContain("Обращений 18 · показов 4 · закрыто сделок 2");
    expect(privateRow.detail).toContain("среднее за 7 дней 3");
    for (const label of ["Расход", "Комиссия", "Цена обращения"]) expect(privateRow.detail).not.toContain(label);
    const visible = buildCleanWorkQueues({ ...privateData, seesMoney: true }, allowed)[0].rows[0];
    for (const label of ["Расход", "Комиссия", "Цена обращения"]) expect(visible.detail).toContain(label);
    const html = renderToStaticMarkup(<MemoryRouter><CleanWorkQueues data={privateData} allowedRoute={allowed} /></MemoryRouter>);
    expect(html).toContain("Результаты каналов");
    expect(html).toContain("Месяц 2026-10");
    expect(html).not.toContain("<details open");
    expect(buildCleanWorkQueues(privateData, () => false)).toEqual([]);
    expect(buildCleanWorkQueues({ ...privateData, modulesOff: ["marketing"] }, allowed)).toEqual([]);
  });
});


describe("visual working dashboard", () => {
  it.each([["WEBSITE","globe"],["REFERRAL","handshake"],["PHONE_CALL","phone"],["INSTAGRAM","instagram"]])("uses a recognizable icon for %s", (source, icon) => {
    const data: MissionControlData={...base,marketing:{instagramCommentsWaiting:0,funnelMonth:"2026-10",funnel:[{source,label:source,leadsMonth:1,showingsMonth:0,dealsClosedMonth:0,spendMonthTjs:null,commissionMonthTjs:null,costPerLeadTjs:null,leadsToday:1,leadsTrailing7Avg:1,anomalyLeadsDown:false}]}};
    const html=renderToStaticMarkup(<MemoryRouter><CleanWorkQueues data={data} allowedRoute={()=>true}/></MemoryRouter>);
    expect(html).toContain(`lucide-${icon}`);
  });

  it("retains every loaded team member, real portraits and secondary metrics behind details", () => {
    const data: MissionControlData = { ...base, team: { agents: Array.from({length: 7}, (_,i)=>({id:`agent-${i}`,fullName:`Сотрудник ${i}`,avatarUrl:i===0?"/uploads/actual-avatar.jpg":null,activeLoad:10+i,pendingAccept:2,acceptedToday:3,buyerCount:4,sellerCount:6,takesLeads:false})) } };
    const html=renderToStaticMarkup(<MemoryRouter><CleanWorkQueues data={data} allowedRoute={(path)=>path==="/team"} /></MemoryRouter>);
    expect(html).toContain('src="/uploads/actual-avatar.jpg"');
    expect(html).toContain("width:44px");
    expect(html).toContain("ещё 4");
    for(let i=0;i<7;i++)expect(html.match(new RegExp(`href="/team/agent-${i}"`,"g"))).toHaveLength(1);
    for(const label of ["покупателей 4", "продавцов 6", "принято сегодня 3", "приём лидов на паузе"])expect(html).toContain(label);
    let anchorDepth = 0;
    for (const tag of html.matchAll(/<\/?a(?:\s[^>]*|)>/g)) { anchorDepth += tag[0].startsWith("</") ? -1 : 1; expect(anchorDepth).toBeGreaterThanOrEqual(0); expect(anchorDepth).toBeLessThanOrEqual(1); }
    expect(anchorDepth).toBe(0);
  });
  it("represents publication without inventing a property photo and keeps all preparation stages", () => {
    const data: MissionControlData={...base,marketing:{instagramCommentsWaiting:0,funnel:[],funnelMonth:"2026-10",publishQueue:{reason:null,count:1,publishedCount:8,items:[{id:"p",shortId:42,title:"Объект42",waitingDays:3}]}},video:{pipeline:{total:10,awaitingReview:1,awaitingPhotos:2,awaitingVideo:3,editing:4,overdue:2}}};
    const html=renderToStaticMarkup(<MemoryRouter><CleanWorkQueues data={data} allowedRoute={()=>true}/></MemoryRouter>);
    expect(html).toContain("Фото не передано в сводке");
    expect(html).toContain('src="/illustrations/property-empty.png"');
    expect(html).toContain('href="/properties/42"');
    for(const label of ["Проверка", "Фото", "Видео", "Монтаж", "Просрочено", "Опубликовано: 8"])expect(html).toContain(label);
    expect(html).not.toContain("<details open");
    const withPhoto=renderToStaticMarkup(<MemoryRouter><CleanWorkQueues data={data} allowedRoute={()=>true} propertyPhotos={new Map([["p", "/uploads/real-property.jpg"], ["42", "/uploads/wrong-key.jpg"]])}/></MemoryRouter>);
    expect(withPhoto).toContain('src="/uploads/real-property.jpg"');
    expect(withPhoto).not.toContain("wrong-key");
    expect(withPhoto).not.toContain("Фото не передано");
  });
});
