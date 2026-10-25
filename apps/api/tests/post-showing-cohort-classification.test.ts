import { describe, expect, it } from "vitest";
import { classifyPostShowingFollowup } from "../src/lib/postShowingCohortClassification.js";
const input={excluded:false,publicResponse:false,robotResponse:false,status:"GIVEN_UP",outcome:null,attempts:2,lastAttemptAt:new Date("2026-10-11"),showingAt:new Date("2026-10-10"),asOf:new Date("2026-10-12"),skipReason:null};
describe("separate unanswered attempts from unresolved outcome",()=>{
  it("requires actual completed attempts in the observation window",()=>{
    expect(classifyPostShowingFollowup(input)).toMatchObject({eligible:true,signal:true,state:"NO_RESPONSE_TO_COMPLETED_SURVEY_ATTEMPTS"});
    for(const patch of [{attempts:0},{lastAttemptAt:null},{lastAttemptAt:new Date("2026-10-15")},{status:"NO_ANSWER"},{excluded:true},{skipReason:"station_down"}]) expect(classifyPostShowingFollowup({...input,...patch})).toMatchObject({eligible:false,signal:false});
  });
  it.each(["REFUSED","UNCLEAR"])("%s is an answered unresolved survey and never no-response",outcome=>{
    expect(classifyPostShowingFollowup({...input,status:"DONE",outcome,robotResponse:true})).toMatchObject({eligible:true,signal:false,state:"UNRESOLVED_SURVEY"});
    expect(classifyPostShowingFollowup({...input,status:"DONE",outcome})).toMatchObject({eligible:false,signal:false});
  });
  it("known public response overrides exhausted robot attempts",()=>{
    expect(classifyPostShowingFollowup({...input,publicResponse:true})).toMatchObject({eligible:true,signal:false,state:"RESPONDED"});
  });
});
