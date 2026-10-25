import { describe, expect, it } from "vitest";
import { smsTestResultLabel } from "../smsTestResult";
describe('SMS test receipt wording',()=>{
  it('never calls a dry-run a send',()=>expect(smsTestResultLabel('DRY_RUN')).toContain('ничего не отправлено'));
  it('separates provider acceptance from delivery',()=>{expect(smsTestResultLabel('SENT')).toContain('Провайдер принял');expect(smsTestResultLabel('SENT')).toContain('не подтверждено');});
  it.each([undefined,'UNKNOWN','FAILED'])('does not invent receipt %s',status=>expect(smsTestResultLabel(status)).toContain('не подтверждён'));
});
