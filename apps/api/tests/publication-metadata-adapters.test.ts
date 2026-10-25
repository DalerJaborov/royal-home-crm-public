import { afterEach, describe, expect, it, vi } from "vitest";
import { updateFacebookVideoDescription, updateYouTubeDescription } from "../src/lib/socialPublish.js";
afterEach(()=>vi.unstubAllGlobals());
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{'Content-Type':'application/json'}});
describe('single-attempt existing metadata adapters',()=>{
  it('does not retry ambiguous Facebook write',async()=>{
    const mock=vi.fn().mockRejectedValue(new Error('network response lost'));vi.stubGlobal('fetch',mock);
    expect((await updateFacebookVideoDescription('video','token','caption',true)).ok).toBe(false);expect(mock).toHaveBeenCalledTimes(1);
  });
  it('preserves YouTube snippet fields rather than resetting tags/title/category',async()=>{
    const mock=vi.fn(async(url:string)=>url.includes('oauth2.googleapis.com')?json({access_token:'token'}):url.includes('part=snippet&id=')?json({items:[{snippet:{title:'Original title',categoryId:'24',tags:['original'],defaultLanguage:'ru'}}]}):json({id:'video'}));vi.stubGlobal('fetch',mock);
    expect((await updateYouTubeDescription({clientId:'id',clientSecret:'secret',refreshToken:'refresh'},'video','Ignore title','New caption',true)).ok).toBe(true);
    const calls=mock.mock.calls as unknown as Array<[string,RequestInit]>;
    const body=JSON.parse(String(calls.find(([,init])=>init?.method==='PUT')?.[1].body));
    expect(body.snippet).toEqual({title:'Original title',categoryId:'24',tags:['original'],defaultLanguage:'ru',description:'New caption'});
  });
});
