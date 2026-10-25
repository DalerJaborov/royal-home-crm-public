import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReportBody } from "./MonthlyReports";
describe("monthly unknown counters",()=>{
  it("labels unavailable historical counters instead of showing a false zero",()=>{
    const html=renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><ReportBody canEdit={false} report={{id:"synthetic",periodStart:"2020-01-31T19:00:00Z",notes:null,updatedAt:"2020-03-01T00:00:00Z",updatedBy:null,metrics:{publicInteractionCountersBasis:"UNAVAILABLE",funnel:[{key:"contacted",label:"Contact counter",count:null}],commission:null,expenses:null,dealsCompleted:2,agents:[{agentId:"a",fullName:"Synthetic agent",leads:1,showings:null,deals:2,commission:null}],sources:[],propertiesAdded:0,propertiesSold:0}}}/></QueryClientProvider>);
    expect(html).toContain("Недоступно");
    expect(html).toContain("Это не нулевые значения");
    expect(html).not.toContain("investigation");
  });
});
