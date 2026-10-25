import { describe, expect, it } from "vitest";
import { explicitOwnPhoneFact, fullPhoneIdentity } from "../src/lib/clientPhoneFacts.js";
describe('literal own current contact facts',()=>{
  it.each(['Мой новый номер +992900000001','Звоните мне на +992900000001','Рақами ман +992900000001'])('accepts one own number %s',text=>expect(explicitOwnPhoneFact(text,'CONVERSATION')).toEqual({phone:'+992900000001',correction:false}));
  it.each(['Вот другой номер моего брата +992900000001','Бахшиш, рақами бародарам +992900000001','Мой номер +992900000001 или +992900000002','Не звоните мне на +992900000001','Это не мой номер +992900000001','Мой номер +992900000001 больше не используется','Он сказал «мой номер +992900000001»','Мой номер 12345','Если бы это был мой номер +992900000001'])('rejects ambiguity or third parties %s',text=>expect(explicitOwnPhoneFact(text,'CONVERSATION')).toBeNull());
  it('separates genuine own correction from extra number/apology',()=>{
    expect(explicitOwnPhoneFact('Я ошибся, мой правильный номер +992900000001','CONVERSATION')?.correction).toBe(true);
    expect(explicitOwnPhoneFact('Бахшиш, рақами ман +992900000001','CONVERSATION')?.correction).toBe(false);
    expect(explicitOwnPhoneFact('Мой другой номер +992900000001','CONVERSATION')?.correction).toBe(false);
  });
  it('only accepts client speaker lines, never agent or unlabelled calls',()=>{
    expect(explicitOwnPhoneFact('Агент: Мой номер +992900000001','CALL')).toBeNull();
    expect(explicitOwnPhoneFact('Мой номер +992900000001','CALL')).toBeNull();
    expect(explicitOwnPhoneFact('Агент: Запишем?\nКлиент: Мой номер +992900000001','CALL')?.phone).toBe('+992900000001');
  });
  it('does not collapse international full identities to matching tails',()=>{
    expect(fullPhoneIdentity('+79000000001')).not.toBe(fullPhoneIdentity('+992900000001'));
    expect(fullPhoneIdentity('900000001')).toBe(fullPhoneIdentity('+992900000001'));
  });
});
