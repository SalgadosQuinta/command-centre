/* command-centre test harness — jsdom + mocked fetch.
   Run: npm install jsdom && node tests/run-tests.js
   Strategy: the apps are single-file with no module exports, so the harness
   extracts named functions/objects from the source and exercises them in a
   sandbox, plus jsdom DOM tests for UI pieces. Extend by adding blocks below. */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const gtdSrc = [...fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8')
  .matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const tasksSrc = [...fs.readFileSync(path.join(ROOT, 'tasks', 'index.html'), 'utf8')
  .matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');

let passed = 0, failed = 0;
function assert(cond, name){
  if(cond){ passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}
// Pull a top-level `function name(...){...}` out of a source blob by brace matching
function extractFn(src, name){
  const start = src.indexOf('function ' + name);
  if(start < 0) throw new Error('function not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for(; i < src.length; i++){
    if(src[i] === '{') depth++;
    else if(src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces for ' + name);
}
// Pull `const Name = {...};` object literal
function extractObj(src, name){
  const start = src.search(new RegExp('const\\s+' + name + '\\s*='));
  if(start < 0) throw new Error('object not found: ' + name);
  let i = src.indexOf('{', start), depth = 0;
  for(; i < src.length; i++){
    if(src[i] === '{') depth++;
    else if(src[i] === '}' && --depth === 0) return src.slice(start, i + 1) + ';';
  }
  throw new Error('unbalanced braces for ' + name);
}

(async function(){

  console.log('--- Syntax: all script blocks parse ---');
  {
    let ok = true;
    try { new Function(gtdSrc); new Function(tasksSrc); } catch(e){ ok = false; console.log('   ' + e.message); }
    assert(ok, 'GTD console + Tasks app script blocks are valid JavaScript');
    let swOk = true;
    try { new Function(fs.readFileSync(path.join(ROOT,'sw.js'),'utf8'));
          new Function(fs.readFileSync(path.join(ROOT,'tasks','sw.js'),'utf8')); }
    catch(e){ swOk = false; }
    assert(swOk, 'both service workers are valid JavaScript');
  }

  console.log('--- Unit: esc() ---');
  {
    const line = gtdSrc.split('\n').find(l => l.trim().startsWith('const esc'));
    const esc = new Function(line + '; return esc;')();
    assert(esc('<b>&"</b>') === '&lt;b&gt;&amp;&quot;&lt;/b&gt;', 'esc escapes HTML entities');
    assert(esc(null) === '' || esc(null) === 'null', 'esc handles null without throwing');
  }

  console.log('--- Unit: Tasks app taskHTML ---');
  {
    const esc = s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const isOver = () => false, isClosed = t => ['done','declined'].includes(t.status), fmtD = d => d;
    const taskHTML = eval('(' + extractFn(tasksSrc, 'taskHTML') + ')');
    const out = taskHTML({id:'t1', title:'Fix pump', status:'sent', notes:'See photos', priority:'high',
      attachments:[{path:'u/task-1-a.png', name:'pump.png'}], comments:[]}, false);
    assert(out.includes('data-receipt="u/task-1-a.png"'), 'attachment renders as signed-URL link');
    assert(out.includes('Fix pump') && out.includes('See photos'), 'title and notes render');
    const clean = taskHTML({id:'t2', title:'No files', status:'sent', comments:[]}, true);
    assert(!clean.includes('data-receipt'), 'no attachment markup when none exist');
    const xss = taskHTML({id:'t3', title:'<img src=x onerror=alert(1)>', status:'sent', comments:[]}, true);
    assert(!xss.includes('<img src=x'), 'task title is escaped (XSS)');
  }

  console.log('--- Unit: CloudService auth refresh-on-401 ---');
  {
    const calls = [];
    const sandboxFetch = async (url, opts) => {
      calls.push({url, opts});
      if(url.includes('/auth/v1/token?grant_type=refresh_token'))
        return { ok:true, json: async () => ({access_token:'AT2', refresh_token:'RT2', user:{id:'u1'}}) };
      if(url.includes('/rest/v1/probe')){
        const auth = (opts.headers || {}).Authorization || '';
        if(auth.includes('EXPIRED')) return { ok:false, status:401, text: async () => 'jwt expired' };
        return { ok:true, status:200, text: async () => '[{"ok":true}]' };
      }
      return { ok:false, status:404, text: async () => 'nf' };
    };
    const store = {};
    const sandbox = {
      fetch: sandboxFetch,
      localStorage: { getItem: k => store[k] || null, setItem: (k,v) => store[k] = v, removeItem: k => delete store[k] },
      CLOUD: null, console
    };
    const src = 'const CLOUD={url:"https://x.test",key:"k"};\n' + extractObj(gtdSrc, 'CloudService') + '\nreturn CloudService;';
    const CloudService = new Function('fetch','localStorage','console', src)(sandbox.fetch, sandbox.localStorage, console);
    CloudService.store({access_token:'EXPIRED', refresh_token:'RT1', user:{id:'u1'}});
    const rows = await CloudService.api('probe?select=*');
    assert(CloudService.session.access_token === 'AT2', 'token refreshed after 401');
    assert(Array.isArray(rows) && rows[0].ok, 'request retried and succeeded after refresh');
    assert(typeof CloudService.uploadTaskFile === 'function', 'uploadTaskFile helper exists');
  }

  console.log('--- DOM: openPersonTaskModal (direct add under a person) ---');
  {
    const dom = new JSDOM('<div id="modalHost"></div>', {url:'https://example.test/'});
    const w = dom.window, d = w.document;
    const apiCalls = [], notifies = [], toasts = [];
    const stubs = {
      document: d, window: w,
      $: sel => d.querySelector(sel),
      $$: sel => [...d.querySelectorAll(sel)],
      esc: s => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'),
      toast: (m) => toasts.push(m),
      fillPeople: () => { stubs.fillPeopleCalled = true; },
      CloudService: {
        me: () => ({id:'me1', email:'r@x.com'}),
        api: async (p, o) => { apiCalls.push({p, o}); return null; },
        uploadTaskFile: async f => ({path:'me1/task-1-' + f.name, name:f.name}),
        receiptUrl: async p => 'https://signed/' + p
      },
      PushService: { notify: (...a) => notifies.push(a) }
    };
    const fnSrc = extractFn(gtdSrc, 'openPersonTaskModal');
    const openPersonTaskModal = new Function(
      'document','window','$','$$','esc','toast','fillPeople','CloudService','PushService',
      fnSrc + '\nreturn openPersonTaskModal;'
    )(d, w, stubs.$, stubs.$$, stubs.esc, stubs.toast, stubs.fillPeople, stubs.CloudService, stubs.PushService);

    // Add mode
    openPersonTaskModal({id:'p1', display_name:'Tapiwa', email:'t@x.com'}, null);
    assert(!!d.querySelector('#ptTitle'), 'add-task modal opens with title field');
    assert(!d.querySelector('#ptStatus'), 'no status field in add mode');
    d.querySelector('#ptSave').onclick(); // empty title
    await new Promise(r => setTimeout(r, 10));
    assert(toasts.some(t => /title/i.test(t)) && apiCalls.length === 0, 'validation blocks empty title');
    d.querySelector('#ptTitle').value = 'Buy feed';
    d.querySelector('#ptNotes').value = '2 bags';
    await d.querySelector('#ptSave').onclick();
    assert(apiCalls.length === 1 && apiCalls[0].o.method === 'POST', 'direct add POSTs cloud_tasks (no capture step)');
    assert(apiCalls[0].o.body.assignee_id === 'p1' && apiCalls[0].o.body.title === 'Buy feed', 'task assigned straight to the person');
    assert(notifies.length === 1 && notifies[0][0] === 'p1', 'person is push-notified of the new task');
    assert(stubs.fillPeopleCalled, 'people view refreshes after save');

    // Edit mode
    apiCalls.length = 0;
    openPersonTaskModal({id:'p1', display_name:'Tapiwa', email:'t@x.com'},
      {id:'ct1', title:'Old title', notes:'n', status:'seen', priority:'normal',
       attachments:[{path:'me1/task-0-x.png', name:'x.png'}]});
    assert(!!d.querySelector('#ptStatus'), 'edit mode shows status select');
    assert(d.querySelector('[data-receipt="me1/task-0-x.png"]') !== null, 'existing attachment listed in edit modal');
    d.querySelector('#ptTitle').value = 'New title';
    d.querySelector('#ptStatus').value = 'in_progress';
    await d.querySelector('#ptSave').onclick();
    assert(apiCalls.length === 1 && apiCalls[0].o.method === 'PATCH' && apiCalls[0].p.includes('ct1'), 'edit PATCHes the existing task');
    assert(apiCalls[0].o.body.title === 'New title' && apiCalls[0].o.body.status === 'in_progress', 'edited fields persisted');
    assert(Array.isArray(apiCalls[0].o.body.attachments) && apiCalls[0].o.body.attachments.length === 1, 'existing attachments preserved on edit');
  }


  console.log('--- Goal money metrics ---');
  {
    const fn = extractFn(gtdSrc, 'moneyMetricSummary');
    const moneyMetricSummary = new Function(fn + '\nreturn moneyMetricSummary;')();
    const m1 = moneyMetricSummary('debt_free', {debts:[
      {balance:5000, principal:20000, currency:'GBP'},
      {balance:0, principal:10000, currency:'GBP'}]});
    assert(m1.pct === 83 && m1.text.includes('83% paid down'), 'debt-free progress computed (25k of 30k paid = 83%)');
    const m2 = moneyMetricSummary('debt_free', {debts:[]});
    assert(m2.pct === 100 && m2.good === true, 'no debts = debt free');
    const m3 = moneyMetricSummary('farm_net', {income:[{amount:5000,currency:'GBP'}],
      payments:[{amount:2000,currency:'GBP'}], expenses:[{amount:1500,currency:'GBP'}]});
    assert(m3.good === true && m3.text.includes('+£1,500') && m3.text.includes('break-even'), 'farm net positive = at break-even');
    const m4 = moneyMetricSummary('farm_net', {income:[{amount:1000,currency:'GBP'}], payments:[{amount:3000,currency:'GBP'}], expenses:[]});
    assert(m4.good === false && m4.text.includes('below break-even'), 'farm net negative flagged below break-even');
  }

  console.log('--- Rail reorganisation ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    ['Engage','Process','Do','People &amp; work','Money','Horizons','Library','Reflect','System'].forEach(sec=>{
      assert(gtd.includes('>' + sec + '</div>'), 'rail section present: ' + sec.replace('&amp;','&'));
    });
    ['focus','calendar','inbox','clarify','next','projects','waiting','people','clients','finance','goals','someday','notes','reference','review','settings'].forEach(v=>{
      assert((gtd.match(new RegExp('data-view="' + v + '"','g'))||[]).length >= 1, 'view button retained: ' + v);
    });
    assert(gtd.includes('money.forgiatus.com'), 'Family Money cross-link in Money section');
    assert(gtd.includes('id="goMetric"'), 'goal editor has money metric select');
  }

  console.log('--- Static: wiring present in built files ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd.includes('id="pplAddTask"'), 'Add task button in person view');
    assert(gtd.includes('notes,priority,attachments'), 'person view query includes attachments');
    assert(/tasksapp-v\d+/.test(fs.readFileSync(path.join(ROOT,'tasks','sw.js'),'utf8')), 'tasks SW cache versioned');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
