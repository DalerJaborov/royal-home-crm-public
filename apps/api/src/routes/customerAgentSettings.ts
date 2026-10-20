// Owner controls mounted beneath the existing authenticated settings router.
import { Router } from "express";
import { ZodError } from "zod";
import { requireAuth, requirePermission } from "../auth/middleware.js";
import { requireElevation } from "../lib/stepUp.js";
import { CustomerAgentOwnerError, registerCustomerAgentForOwner, publishCustomerAgentForOwner,
  killCustomerAgentForOwner, readCustomerAgentOwnerState, refreshCurrentCustomerAgentForOwner } from "../lib/customerAgentOwnerPolicy.js";
export const customerAgentSettingsRouter=Router();
customerAgentSettingsRouter.use(requireAuth,requirePermission('settings.manage'));
function handler(run:(actorId:string,body:unknown)=>Promise<unknown>) {
  return async(req:import('express').Request,res:import('express').Response,next:import('express').NextFunction)=>{
    if(!req.agent) return res.status(401).json({error:'unauthenticated'});
    try { return res.json(await run(req.agent.id,req.body)); }
    catch(error) {
      if(error instanceof CustomerAgentOwnerError) return res.status(error.status).json({error:error.code,...(error.status===428?{stepUpRequired:true}:{})});
      if(error instanceof ZodError) return res.status(400).json({error:'invalid_customer_agent_control',issues:error.issues.map(i=>({path:i.path,code:i.code}))});
      return next(error);
    }
  };
}
customerAgentSettingsRouter.get('/',handler(actor=>readCustomerAgentOwnerState(actor)));
// Explicit routine release adoption: existing signed-in owner, retained policy.
// Arbitrary registration, rollout/permission changes and kill remain elevated.
customerAgentSettingsRouter.post('/refresh-current',handler(refreshCurrentCustomerAgentForOwner));
customerAgentSettingsRouter.post('/revisions/register',requireElevation,handler(registerCustomerAgentForOwner));
customerAgentSettingsRouter.put('/rollout',requireElevation,handler(publishCustomerAgentForOwner));
customerAgentSettingsRouter.post('/kill',requireElevation,handler(killCustomerAgentForOwner));
