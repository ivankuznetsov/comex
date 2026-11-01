// Loaded only by the isolated E2E server via NODE_OPTIONS; never use a real key.
if (process.env.COMEX_E2E_FAKE_PROVIDER !== '1' || process.env.OPENAI_API_KEY !== 'e2e-fake-key') {
  throw new Error('The fake provider requires explicit E2E mode and the fake API key.');
}
const originalFetch = globalThis.fetch;
const png = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAGUlEQVQokWP4f8OWJMQwquHGaCj9H65JAwCU0RQfXd08LgAAAABJRU5ErkJggg==';
const state = {location:'London',time:'day',props:[],outfits:[],injuries:[],knowledge:[]};

globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input.url || String(input);
  if (!url.startsWith('https://api.openai.com/v1/')) return originalFetch(input, init);
  if (url.includes('/images/')) return Response.json({data:[{b64_json:png}]});
  const body = JSON.parse(init.body);
  const name = body.text.format.name;
  const raw = body.input[1].content;
  const payload = JSON.parse(typeof raw === 'string' ? raw : raw[0].text);
  let output;
  if (name === 'narrative_questions') output = {questions:[{id:'goal',question:'What does Mina want?',suggested_answer:'Deliver the key'}]};
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
