import { chromium, expect } from '@playwright/test';
import { loginApi, seedStorage } from './lib/parity-core.mjs';
import { writeFileSync, mkdirSync } from 'node:fs';
if(process.env.E2E_ISOLATED_SEED !== '1' || process.env.E2E_ALLOW_ROLLOUT_WRITES !== '1') throw Error('Only the explicitly isolated UI4805/5305 seed with authorized QA writes');
const base='http://127.0.0.1:5305', browser=await chromium.launch(), results=[], failures=[];
mkdirSync('.scratch-clean/expense-transfer-shots',{recursive:true});
try {
 const deadline=Date.now()+60000;
 for(;;){try{if((await fetch(base)).ok)break;}catch{} if(Date.now()>deadline)throw Error('Stand startup timeout');await new Promise(r=>setTimeout(r,500));}
 for(const role of ['director','admin','shareholder']) {
  const authCtx=await browser.newContext({baseURL:base});
  const auth=await loginApi(authCtx,base,role), cookies=await authCtx.cookies(); await authCtx.close();
  for(const width of [1440,390]) for(const theme of ['light','night']) {
   const ctx=await browser.newContext({baseURL:base,viewport:{width,height:width===390?844:1000},serviceWorkers:'block'});
   await ctx.addCookies(cookies); await seedStorage(ctx,{...auth,theme});
   const page=await ctx.newPage(), errors=[];page.on('pageerror',e=>errors.push(e.message));
   for(const workspace of ['expenses','recurring','calendar','table','overview','payouts']) {
    try {
     await page.goto(`/finance?shell=clean&workspace=${workspace}`);
     await expect(page.locator('.cef-page')).toBeVisible();
     await expect(page.locator('.cef-panel')).not.toContainText('Что-то пошло не так');
     await expect(page.locator('.cef-panel [role="status"]')).toHaveCount(0,{timeout:15000});
     expect(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),'page overflow').toBe(false);
     expect(errors).toEqual([]);
     if(role==='shareholder') await expect(page.locator('.cef-add')).toHaveCount(0);
     if(role==='director') await page.screenshot({path:`.scratch-clean/expense-transfer-shots/${workspace}-${width}-${theme}.png`,fullPage:true});
     results.push({role,width,theme,workspace});
    } catch(e) {failures.push({role,width,theme,workspace,error:e.message});}
   }
   if(role==='director'&&theme==='light') {
    try {
     await page.goto('/finance?shell=clean&workspace=expenses');
     await page.locator('.cef-add').click();
     const dialog=page.getByRole('dialog',{name:'Новый расход'});
     await expect(dialog).toBeVisible();
     await dialog.getByLabel('Сумма расхода',{exact:true}).fill('123');
     await dialog.getByLabel('Название расхода',{exact:true}).fill(`QA transfer ${width}`);
     await dialog.locator('.cef-tile').first().click();
     await page.screenshot({path:`.scratch-clean/expense-transfer-shots/sheet-${width}-light.png`});
     await dialog.getByRole('button',{name:'Готово',exact:true}).click();
     await expect(dialog).toHaveCount(0);
     await expect(page.locator('.cef-feed')).toContainText(`QA transfer ${width}`);
     await page.getByRole('button',{name:'Отменить',exact:true}).last().click();
     await expect(page.locator('.cef-feed')).not.toContainText(`QA transfer ${width}`);
     results.push({role,width,flow:'create-undo'});
     await page.getByRole('button',{name:'Категории и лимиты'}).click();
     await expect(page.getByRole('dialog')).toBeVisible();
     expect(await page.getByRole('dialog').evaluate(el=>getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
     await page.keyboard.press('Escape');
     await expect(page.getByRole('dialog')).toHaveCount(0);
     results.push({role,width,flow:'category-sheet'});
     await page.getByRole('button',{name:'Оплатил',exact:true}).first().click();
     await page.getByRole('button',{name:'Отменить',exact:true}).last().click();
     await expect(page.getByRole('button',{name:'Оплатил',exact:true}).first()).toBeVisible();
     results.push({role,width,flow:'pay-undo'});
     await page.getByRole('tab',{name:'Таблица',exact:true}).click();
     const download=page.waitForEvent('download');
     await page.getByRole('button',{name:'Скачать для Excel',exact:true}).click();
     expect((await download).suggestedFilename()).toMatch(/\.csv$/);
     await page.getByRole('button',{name:'Сводка',exact:true}).click();
     await expect(page.locator('.cef-pivot')).toBeVisible();
     await page.locator('.cef-pivot-value').first().click();
     await expect(page.locator('.cef-expense-grid')).toBeVisible();
     results.push({role,width,flow:'csv-pivot-drilldown'});
     await page.locator('.cef-table-filters select').first().selectOption('');
     const [sorted]=await Promise.all([
       page.waitForResponse(r=>new URL(r.url()).pathname.endsWith('/expenses')&&new URL(r.url()).searchParams.get('sortBy')==='amount'),
       page.getByRole('button',{name:'Сортировать: Сумма',exact:true}).click(),
     ]);
     expect(sorted.ok()).toBe(true);
     await expect(page.locator('th[aria-sort="ascending"]')).toContainText('Сумма');
     await expect.poll(()=>page.locator('.cef-expense-grid td.cef-amount').count()).toBeGreaterThan(1);
     await expect.poll(async()=>{
       const amounts=await page.locator('.cef-expense-grid td.cef-amount').allTextContents();
       const values=amounts.map(v=>Number(v.split('с.')[0].replace(/[^\d,-]/g,'').replace(',','.')));
       return JSON.stringify(values)===JSON.stringify([...values].sort((a,b)=>a-b));
     }).toBe(true);
     results.push({role,width,flow:'server-sorting'});
    }catch(e){failures.push({role,width,flow:'create-undo-sheet',error:e.message});}
   }
   await ctx.close();
  }
 }
}finally{await browser.close();writeFileSync('.scratch-clean/expense-transfer-browser.json',JSON.stringify({results,failures},null,2));}
console.log(JSON.stringify({passed:results.length,failures},null,2));if(failures.length)process.exitCode=1;
