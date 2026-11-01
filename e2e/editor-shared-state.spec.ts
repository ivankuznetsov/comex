import {expect,test} from '@playwright/test';

test.skip(process.env.COMEX_E2E_MODE!=='hosted','Requires the isolated hosted-mode test server.');

test.beforeEach(async({page})=>{await page.route('**/api/auth/session',route=>route.fulfill({json:{user:{email:'creator@example.test'},guest:null,workspaceId:'workspace-a'}}));});

test('an old edit operation cannot revive a consumed or replaced decision',async({page})=>{
  const version={assetId:'asset-1',storyRevision:1,panelRevision:1};
  const draft:any={id:'shared-edit',title:'Shared edit',plot:'A courier finds a key.',style:'ink-manga',revision:1,storyRevision:1,characters:[],questions:[],answers:{},initialQuestions:'complete',initialSuggestions:'complete',storyApproval:{storyRevision:1,fingerprint:'b'.repeat(64),approved:true},pendingArtworkDecision:null,pages:[{id:'page-1',index:1,status:'current',panels:[{id:'panel-1',imageUrl:'/panel.png',status:'current',evaluation:'pass',reviewVersion:version}]}]};
  const decision={intent:'uncertain',reason:'An old decision',panelId:'panel-1',proposalId:'old-proposal',instruction:'Change the light',reviewedVersion:version};
  await page.route('**/api/comics/shared-edit',route=>route.fulfill({json:{comic:draft}}));
  await page.route('**/api/operations**',route=>new URL(route.request().url()).pathname==='/api/operations' ? route.fulfill({json:{operations:[{id:'old-op',action:'editPanel',comicId:'shared-edit',panelId:'panel-1',status:'needs_review'}]}}) : route.fulfill({json:{id:'old-op',action:'editPanel',comicId:'shared-edit',status:'needs_review',result:{editDecision:decision}}}));
  await page.goto('/comics/shared-edit');await expect(page.getByText('Review the current findings and pending decisions before continuing.')).toBeVisible({timeout:15000});
  await expect(page.getByText('An old decision')).toHaveCount(0);await expect(page.getByText('Does this change the story?')).toHaveCount(0);
  draft.revision=2;draft.pendingArtworkDecision={id:'new-proposal',panelId:'panel-1',instruction:'Change the coat',reason:'The current decision',intent:'uncertain',reviewedVersion:version,current:true,expiresAt:Date.now()+60_000,choices:['preview_story','artwork_only']};
  await page.reload();await expect(page.getByText('The current decision')).toBeVisible();await expect(page.getByText('An old decision')).toHaveCount(0);
  draft.pendingArtworkDecision={...draft.pendingArtworkDecision,current:false,expiresAt:Date.now()-1};
  await page.reload();await expect(page.getByText('Review the current findings and pending decisions before continuing.')).toBeVisible({timeout:15000});await expect(page.getByText('The current decision')).toHaveCount(0);await expect(page.getByText('An old decision')).toHaveCount(0);
});

test('shared refresh merges untouched answers and requires a choice for conflicting edits',async({page})=>{
  let release=false;const sent:any[]=[],jobs=new Map<string,any>();
  const draft:any={id:'shared-answers',title:'Shared answers',plot:'A courier finds a key.',style:'ink-manga',revision:1,storyRevision:1,characters:[],questions:[{id:'q1',question:'Who receives the key?'},{id:'q2',question:'What should happen?'},{id:'q3',question:'Where does it happen?'}],answers:{q1:'Old recipient',q2:'Old event',q3:'Old place'},initialQuestions:'complete',initialSuggestions:'complete',pages:[]};
  await page.route('**/api/comics/shared-answers',route=>route.fulfill({json:{comic:draft}}));
  await page.route('**/api/operations**',route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.method()==='POST'){const body=req.postDataJSON(),id=`job-${sent.length+1}`;sent.push(body);jobs.set(id,body);return route.fulfill({status:202,json:{id,comicId:'shared-answers',status:'queued'}});}
    if(url.pathname==='/api/operations')return route.fulfill({json:{operations:[{id:'remote-op',action:'suggestCharacters',comicId:'shared-answers',status:'running'}]}});
    const id=url.pathname.split('/').at(-1)!;
    if(id==='remote-op')return route.fulfill({json:{id,action:'suggestCharacters',comicId:'shared-answers',status:release?'succeeded':'running',result:{}}});
    const job=jobs.get(id);if(job.action==='update'){draft.answers={...job.input.answers};draft.revision++;}return route.fulfill({json:{id,action:job.action,comicId:'shared-answers',status:'succeeded',result:{}}});
  });
  await page.goto('/comics/shared-answers');await expect(page.getByLabel('Who receives the key?')).toHaveValue('Old recipient');
  await page.getByLabel('What should happen?',{exact:true}).fill('My event');await page.getByLabel('Where does it happen?').fill('My place');
  draft.answers={q1:'MCP recipient',q2:'MCP event',q3:'Old place'};draft.revision=2;release=true;
  await expect(page.getByLabel('Who receives the key?')).toHaveValue('MCP recipient',{timeout:10_000});
  await expect(page.getByLabel('What should happen?',{exact:true})).toHaveValue('My event');await expect(page.getByLabel('Where does it happen?')).toHaveValue('My place');
  await expect(page.getByText(/changed elsewhere/i)).toBeVisible();
  await page.getByRole('button',{name:'Plan story →'}).click();await expect(page.getByText(/resolve the conflicting answers/i)).toBeVisible();expect(sent).toHaveLength(0);
  await page.getByRole('button',{name:'Keep my answer for What should happen?'}).click();await page.getByRole('button',{name:'Plan story →'}).click();
  await expect.poll(()=>sent.length).toBe(2);expect(sent[0]).toMatchObject({action:'update',input:{answers:{q1:'MCP recipient',q2:'My event',q3:'My place'}}});expect(sent[1].action).toBe('planStory');
});
