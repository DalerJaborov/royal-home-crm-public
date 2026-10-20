import {expect,it} from 'vitest';
import {renderCustomerAgentDecision} from '../src/ai/customerAgentRenderer.js';
import {isCustomerPublicAppreciation,customerPublicLanguage} from '../src/ai/customerAgentConversationPolicy.js';
import {customerAgentCompanyInformationHash} from '../src/ai/customerAgentPublicProtocol.js';
const facts={propertyId:'00000000-0000-4000-8000-000000000001',shortId:174,price:'102460',currency:'USD' as const,
 availability:'AVAILABLE' as const,publicAddress:'Synthetic district, Душанбе',addressPolicy:'district_city_only' as const,builder:null,
 publicLink:null,updatedAt:'2026-10-20T00:00:00.000Z',signature:'a'.repeat(64)};
it.each(['Беҳтарин хона бдай 👏👏','Очень красивая квартира!','Зебо бдай 🔥'])('thanks for ordinary praise: %s',text=>{
 expect(isCustomerPublicAppreciation(text)).toBe(true);
});
it.each([
 ['безеб','tg'],['Ика бардакай','tg'],['Не нравится ремонт','ru'],['Кимат','tg'],['Дорого','ru'],
] as const)('answers a pure public reaction without dumping listing facts: %s',(inputText,language)=>{
 expect(customerPublicLanguage(inputText)).toBe(language);
 const result=renderCustomerAgentDecision({decision:{kind:'reply',refs:['e0'],social:'none',question:'topic'},
  evidence:[{ref:'e0',value:{kind:'facts',facts,kinds:['price','address','builder','characteristics']}}],
  surface:'public_comment',language,inputText,requestedFacts:[],knownPhoneSource:'none',maxOutputChars:2000});
 expect(result).toBeTruthy();expect(result).not.toMatch(/102|174|застрой|сохтмон|работ|кор\?/u);
});
it('keeps the approved Tajik office projection in one language without a duplicate city or irrelevant recruitment question',()=>{
 const information={name:'Royal Home',city:'Душанбе',office:'Душанбе, ул. Synthetic 10, 2 этаж',officeTg:'Душанбе, кӯчаи Synthetic 10, 2 ошёна',services:'Synthetic services',hours:null};
 const result=renderCustomerAgentDecision({decision:{kind:'reply',refs:['e0'],social:'none',question:'topic'},
  evidence:[{ref:'e0',value:{kind:'company_information',information,sourceHash:customerAgentCompanyInformationHash(information)}}],
  surface:'dm',language:'tg',inputText:'Шумо аз кучоед',requestedFacts:[],knownPhoneSource:'none',maxOutputChars:2000});
 expect(result).toContain('кӯчаи Synthetic 10, 2 ошёна');expect(result).not.toMatch(/Душанбе, Душанбе|ул\.|этаж|кор\?/u);
});
it('preserves a real price question even with a criticism',()=>{
 const result=renderCustomerAgentDecision({decision:{kind:'reply',refs:['e0'],social:'none',question:'none'},
  evidence:[{ref:'e0',value:{kind:'facts',facts,kinds:['price']}}],surface:'public_comment',language:'ru',
  inputText:'Дорого, какая цена?',requestedFacts:['price'],knownPhoneSource:'none',maxOutputChars:2000});
 expect(result).toContain('102 460 USD');
});
