import { expect, it, vi } from "vitest";
const s=vi.hoisted(()=>({query:undefined as undefined|(()=>Promise<unknown>),api:vi.fn(async()=>({items:[]}))}));
vi.mock("@tanstack/react-query",async(importOriginal)=>({...await importOriginal<typeof import("@tanstack/react-query")>(),useQuery:(o:{queryFn:()=>Promise<unknown>})=>{s.query=o.queryFn;return {data:[],isFetching:false,isError:false};}}));
vi.mock("../store/auth",async(importOriginal)=>({...await importOriginal<typeof import("../store/auth")>(),useAuthStore:(selector:(s:unknown)=>unknown)=>selector({agent:{role:"ADMIN"}})}));
vi.mock("../lib/api",async(importOriginal)=>({...await importOriginal<typeof import("../lib/api")>(),api:s.api}));
vi.mock("../lib/permissions",()=>({useCan:()=>()=>true}));
import { PropertyRemovalDossier } from "./PropertyRemovalDossier";
it("passes an object to api serialization, not an already encoded JSON string",async()=>{
  PropertyRemovalDossier({propertyIds:["synthetic-uuid"]}); await s.query?.();
  expect(s.api).toHaveBeenCalledWith("/properties/removal-dossiers",{method:"POST",body:{propertyIds:["synthetic-uuid"]}});
});
