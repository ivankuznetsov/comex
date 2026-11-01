// Loaded only by the isolated E2E server via NODE_OPTIONS; never use a real key.
if (process.env.COMEX_E2E_FAKE_PROVIDER !== '1' || process.env.OPENAI_API_KEY !== 'e2e-fake-key') {
  throw new Error('The fake provider requires explicit E2E mode and the fake API key.');
}
const originalFetch = globalThis.fetch;
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4f8OWJMQwquHGaCj9H65JAwCU0RQfXd08LgAAAABJRU5ErkJggg==';
const state = {location:'London',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url || String(input);
  if (url === 'https://api.resend.com/emails') {
    if (process.env.RESEND_API_KEY !== 'e2e-fake-resend-key' || !process.env.COMEX_E2E_MAILBOX) throw new Error('The fake mailer requires E2E settings.');
    const body = JSON.parse(init.body);
    if (body.to.length !== 1 || !/^[a-z0-9+]+@example\.test$/.test(body.to[0])) throw new Error('Unexpected fake email recipient.');
    require('node:fs').writeFileSync(require('node:path').join(process.env.COMEX_E2E_MAILBOX, `${body.to[0]}.json`), JSON.stringify(body), {mode:0o600});
    return Response.json({id:'fake-email'});
  }
  if (!url.startsWith('https://api.openai.com/v1/')) return originalFetch(input, init);
  if (url.includes('/images/')) {
    const fs=require('node:fs'), path=require('node:path');
    const hold=path.join(process.env.COMEX_E2E_MAILBOX,'hold-image');
    const count=path.join(process.env.COMEX_E2E_MAILBOX,'image-count');
    fs.appendFileSync(count,'1\n');
    const deadline=Date.now()+90_000;
    while (fs.existsSync(hold) && Date.now()<deadline) await new Promise(resolve=>setTimeout(resolve,25));
    if (fs.existsSync(hold)) throw new Error('Timed out waiting for test image release');
    const prompt = typeof init.body === 'string' ? JSON.parse(init.body).prompt : init.body.get('prompt');
    if (String(prompt).includes('Retryref') && !require('node:fs').existsSync(require('node:path').join(process.env.COMEX_E2E_MAILBOX, 'allow-reference'))) {
      return Response.json({error:{message:'Simulated reference failure'}},{status:400});
    }
    return Response.json({data:[{b64_json:png}]});
  }
  const body = JSON.parse(init.body);
  const name = body.text.format.name;
  const raw = body.input[1].content;
  const payload = JSON.parse(typeof raw === 'string' ? raw : raw[0].text);
  if (name === 'narrative_questions' && payload.plot.includes('AUTORETRYQUESTIONS') && !require('node:fs').existsSync(require('node:path').join(process.env.COMEX_E2E_MAILBOX, 'allow-questions'))) {
    return Response.json({error:{message:'Simulated questions failure'}},{status:400});
  }
  let output;
  if (name === 'narrative_questions') output = {questions:[{id:'goal',question:'What does Mina want?',suggested_answer:'Deliver the key'}]};
  else if (name === 'character_suggestions') output = {characters:[{name:'Mina',role:'Courier',appearance:'Short red hair and freckles',outfit:'Yellow raincoat'}]};
  else if (name === 'storyboard') {
    const id = payload.characters[0].id;
    output = {bible:{premise:payload.plot,setting:'London',rules:['Mina carries the key'],character_ids:[id]},pages:Array.from({length:payload.pageCount},(_,i) => ({index:i+1,panels:Array.from({length:payload.panelsPerPage},(_,j) => ({id:`panel-${i+1}-${j+1}`,index:j+1,character_ids:[id],action:`Mina moves through scene ${i+1}-${j+1}`,framing:'wide',dialogue:[],state_before:state,state_after:state}))}))};
  } else if (name === 'narrative_judgment' || name === 'visual_judgment') output = {outcome:'pass',findings:[]};
  else if (name === 'edit_intent') output = {intent:'artwork',reason:'Colour only'};
  else if (name === 'plot_revision') {
    const panels = payload.current_beats_and_states.flatMap(page => page.panels);
    const index = panels.findIndex(panel => panel.id === payload.requested_start);
    output = {earliest_affected_panel_id:payload.requested_start,explanation:'The later journey changes.',revised_bible:payload.current_bible,revised_suffix:panels.slice(index).map(panel => ({...panel,action:`Revised ${panel.action}`}))};
  } else throw new Error(`Unexpected fake provider request: ${name}`);
  return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(output)}]}]});
};
