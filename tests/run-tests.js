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
    const src = 'const CLOUD={url:"https://x.test",key:"k"};\nconst OfflineService={set(){},cache(){},cached(){return null},isNet(){return false},q(){return[]},queue(){},replay(){},badge(){}};\n' + extractObj(gtdSrc, 'CloudService') + '\nreturn CloudService;';
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
      PushService: { notify: (...a) => notifies.push(a) },
      WhatsAppService: { send: (...a) => { stubs.waSent = (stubs.waSent||[]).concat([a]); return Promise.resolve(true); } }
    };
    const fnSrc = extractFn(gtdSrc, 'openPersonTaskModal');
    const openPersonTaskModal = new Function(
      'document','window','$','$$','esc','toast','fillPeople','CloudService','PushService','WhatsAppService',
      fnSrc + '\nreturn openPersonTaskModal;'
    )(d, w, stubs.$, stubs.$$, stubs.esc, stubs.toast, stubs.fillPeople, stubs.CloudService, stubs.PushService, stubs.WhatsAppService);

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
    assert((stubs.waSent||[]).length === 1 && stubs.waSent[0][0] === 'p1' && /Buy feed/.test(stubs.waSent[0][1]), 'WhatsApp notification fired with the task title');
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


  console.log('--- Revenue: confirmed vs proposal ---');
  {
    const fn = extractFn(gtdSrc, 'financeIsConfirmed');
    const isConf = new Function(fn + '\nreturn financeIsConfirmed;')();
    const stages = {'acme':'won','beta co':'proposal'};
    assert(isConf({status:'expected', client:'Acme'}, stages) === true, 'client at stage won counts as confirmed');
    assert(isConf({status:'expected', client:'Beta Co'}, stages) === false, 'proposal-stage client not counted');
    assert(isConf({status:'invoiced', client:'Beta Co'}, stages) === true, 'invoiced always confirmed');
    assert(isConf({status:'expected'}, stages) === false, 'unlinked entry defaults to proposal');
    assert(isConf({status:'expected', confirmed:true}, stages) === true, 'manual confirm wins');
    assert(isConf({status:'invoiced', confirmed:false}, stages) === false, 'manual unconfirm overrides even invoiced');
  }

  console.log('--- Rail: collapsible sections ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd.includes('navFoldEnsureVisible'), 'fold logic present with view auto-unfold');
    assert(gtd.includes('id="navFoldAll"') && gtd.includes('id="navUnfoldAll"'), 'fold-all / unfold-all controls present');
    // functional: jsdom with a stub rail
    const dom = new JSDOM('<nav class="rail"><div class="navsec">Do</div><button class="navbtn" data-view="next">Next</button><div class="navsec">Money</div><button class="navbtn" data-view="finance">Fin</button><div class="navfoldall"><button id="navFoldAll">f</button><button id="navUnfoldAll">u</button></div></nav>', {url:'https://x.test/', runScripts:'outside-only'});
    const iife = gtdSrc.slice(gtdSrc.indexOf('/* Collapsible rail sections'));
    dom.window.eval(iife);
    const d = dom.window.document;
    d.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    assert(d.querySelectorAll('.rail .chev').length === 2, 'chevrons added to section headers');
    d.querySelectorAll('.rail .navsec')[0].dispatchEvent(new dom.window.Event('click'));
    assert(d.querySelector('[data-view="next"]').classList.contains('navfolded'), 'clicking a section folds its buttons');
    assert(!d.querySelector('[data-view="finance"]').classList.contains('navfolded'), 'other sections unaffected');
    assert(JSON.parse(dom.window.localStorage.getItem('gtd_navfold')).includes('Do'), 'fold state persisted');
    d.getElementById('navUnfoldAll').onclick();
    assert(!d.querySelector('[data-view="next"]').classList.contains('navfolded'), 'unfold all restores buttons');
    dom.window.navFoldEnsureVisible && (d.querySelectorAll('.rail .navsec')[1].dispatchEvent(new dom.window.Event('click')), dom.window.navFoldEnsureVisible('finance'));
    assert(!d.querySelector('[data-view="finance"]').classList.contains('navfolded'), 'navigating to a view auto-unfolds its section');
  }


  console.log('--- Money summary view ---');
  {
    const fn = extractFn(gtdSrc, 'computeSpaceSummary');
    const cs = new Function(fn + '\nreturn computeSpaceSummary;')();
    const m = cs({
      bills:[{amount:100,currency:'GBP',due_date:'2026-07-20'},{amount:50,currency:'GBP',due_date:'2026-07-01'}],
      income:[{amount:2000,currency:'GBP'}],
      payments:[{amount:500,currency:'GBP'}],
      expenses:[{amount:300,currency:'GBP'}],
      debts:[{balance:4000,currency:'GBP'}]
    }, '2026-07-18');
    assert(m.dueCount===1 && m.overdueCount===1, 'due vs overdue split on today');
    assert(m.netStr.includes('1,200') && m.netGood===true, 'month net = 2000-800 positive');
    assert(m.debtStr.includes('4,000') && m.hasDebt, 'owing total shown');
    const clean = cs({bills:[],income:[],payments:[],expenses:[],debts:[{balance:0,currency:'GBP'}]}, '2026-07-18');
    assert(clean.hasDebt===false, 'zero balances = debt free');

    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd.includes('data-view="money"'), 'Money nav button present');
    assert(gtd.includes('>Pipeline</button>'), 'Finance renamed Pipeline in nav');
    assert(gtd.includes('<h1>Pipeline</h1>'), 'view retitled Pipeline');
    assert(gtd.includes('AppState.currentView==="money"'), 'money summary fill hooked to render');
    // fold controls now precede the first section
    assert(gtd.indexOf('id="navFoldAll"') < gtd.indexOf('>Engage</div>'), 'fold controls at the top of the rail');
  }


  console.log('--- Mobile menu: top accordion grouped like the rail ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    const i = gtd.indexOf('const mm=$("#mobMore")');
    const sheet = gtd.slice(i, i+4200);
    ['Engage','Process','Do','People & work','Money','Horizons','Library','Reflect','System'].forEach(g=>{
      assert(sheet.includes('"' + g + '"'), 'More sheet group present: ' + g);
    });
    assert(sheet.includes('["money","Money"]') && sheet.includes('["finance","Pipeline"]'), 'Money and Pipeline reachable on mobile');
    assert(sheet.includes('money.forgiatus.com'), 'Family Money link in the mobile Money group');
    assert(sheet.includes('data-mcapture') && sheet.includes('data-msmart'), 'capture shortcuts kept at the top');
  }


  console.log('--- WhatsApp notifications ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(fs.existsSync(path.join(ROOT,'supabase/functions/notify-whatsapp/index.ts')), 'notify-whatsapp edge function file present');
    const fnSrc = fs.readFileSync(path.join(ROOT,'supabase/functions/notify-whatsapp/index.ts'),'utf8');
    assert(fnSrc.includes('api.callmebot.com') && fnSrc.includes('encodeURIComponent'), 'edge function calls CallMeBot with encoded params');
    assert(gtd.includes('functions/v1/notify-whatsapp'), 'app calls the edge function');
    assert(gtd.includes('fam_notify_prefs'), 'config read from the admin-managed prefs table');
    assert(gtd.includes('id="pplWa"') && gtd.includes('managed in Julius Family Money'), 'People view points at the admin portal');
    assert(gtd.includes('"task_assigned");'), 'task creation fires with the task_assigned event');
    assert(gtd.includes('WhatsAppService.send(assigneeId,') && gtd.includes('"Task updated by "'), 'delegation and update paths fire with events');


    // functional: allowed() gating
    const src = gtdSrc;
    const i0 = src.indexOf('const WhatsAppService={');
    const i1 = src.indexOf('};', src.indexOf('return r.ok;')) + 2;
    const WhatsAppService = new Function('CloudService','CLOUD',
      src.slice(i0, i1).replace('const WhatsAppService=','return ') )({session:null, api:async()=>[]}, {url:'',key:''});
    const base = {wa_enabled:true, wa_phone:'+44770', wa_key:'99', events:{task_assigned:true, task_updated:false}};
    assert(WhatsAppService.allowed(base,'task_assigned') === true, 'assigned event allowed when on');
    assert(WhatsAppService.allowed(base,'task_updated') === false, 'updated event blocked when toggled off');
    assert(WhatsAppService.allowed(Object.assign({},base,{wa_enabled:false}),'task_assigned') === false, 'master switch off blocks everything');
    assert(WhatsAppService.allowed(Object.assign({},base,{wa_key:null}),'task_assigned') === false, 'missing key blocks sending');
    assert(WhatsAppService.allowed(Object.assign({},base,{events:null}),'task_assigned') === true, 'assigned defaults on when events unset');
    assert(WhatsAppService.allowed(null,'task_assigned') === false, 'no prefs row means no message');
    const sent = await WhatsAppService.send('p1','hello','task_assigned');
    assert(sent === false, 'send is a safe no-op without a session');
  }

  console.log('--- Mobile accordion behaviour hooks ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd.includes('id="mobMenu"') && gtd.includes('id="mobScrim"'), 'menu panel and scrim exist');
    assert(gtd.includes('mviews tiles'), 'More menu renders view tiles');
    assert(gtd.includes('msec static'), 'section labels are static, no dropdown accordion');
    assert(!gtd.includes('data-msec='), 'accordion toggles removed');
    assert(gtd.includes('const cur=AppState.currentView') && gtd.includes('${v[0]===cur?"active":""}'), 'current view highlighted among tiles');
  }


  console.log('--- GTD notification admin (all task people) ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd.includes('id="npAdmin"'), 'Settings has the WhatsApp admin card');
    assert(gtd.includes('AppState.currentView==="settings") fillNotifyAdmin()'), 'admin fill hooked to the Settings view');
    assert(gtd.includes('fam_members?select=user_id'), 'family membership fetched for differentiation');
    assert(gtd.includes('"family":"task-only"'), 'people badged family vs task-only');
    assert(gtd.includes('on_conflict=user_id') && gtd.includes('merge-duplicates'), 'save upserts fam_notify_prefs');
    assert(gtd.includes('WhatsAppService._prefs=null'), 'prefs cache invalidated after save');
    assert(gtd.includes('migration 014'), 'helpful message when the prefs table is missing');
  }


  console.log('--- Tasks app: assignee-only lists + reassignment ---');
  {
    const tsrc = fs.readFileSync(path.join(ROOT,'tasks/index.html'),'utf8');
    // dashboard and calendar draw from assignedToMe, never ALL
    assert(tsrc.includes('const open=assignedToMe().filter'), 'dashboard counts only tasks assigned to me');
    assert(tsrc.includes('assignedToMe().forEach(t=>{if(t.due_date'), 'calendar shows only tasks assigned to me');
    assert(tsrc.includes('delegatedByMe'), 'delegated-by-me helper exists');
    assert(tsrc.includes('Sent to others — waiting on them'), 'delegated tasks shown in their own labelled section');
    assert(tsrc.includes('assignee:assignee_id(email,display_name)'), 'assignee names fetched for the delegated view');
    // reassignment
    assert(tsrc.includes('openReassign') && tsrc.includes('data-reassign'), 'reassign control wired');
    assert(tsrc.includes('{assignee_id:who,status:"sent"}'), 'reassign patches assignee and resets status');
    assert(tsrc.includes('"Task reassigned to you"'), 'new assignee push-notified');
    assert(tsrc.includes('fam_notify_prefs?user_id=eq.') && tsrc.includes('task_assigned'), 'WhatsApp best-effort respects admin prefs');

    // functional: the filters themselves
    const helpers = ['const assignedToMe', 'const delegatedByMe', 'const inboxTasks', 'const myTasks'];
    const i0 = tsrc.indexOf(helpers[0]);
    const i1 = tsrc.indexOf('const isClosed');
    const me = {id:'me1'};
    const mk = new Function('ALL','Cloud', tsrc.slice(i0,i1) + '\nreturn {assignedToMe,delegatedByMe,inboxTasks,myTasks};');
    const ALL=[
      {id:'a', owner_id:'me1', assignee_id:'me1'},   // my own
      {id:'b', owner_id:'other', assignee_id:'me1'}, // inbox
      {id:'c', owner_id:'me1', assignee_id:'brandon'} // delegated (the bug)
    ];
    const f = mk(ALL, {me:()=>me});
    assert(f.assignedToMe().map(t=>t.id).join(',')==='a,b', 'assignedToMe excludes tasks delegated to Brandon');
    assert(f.delegatedByMe().map(t=>t.id).join(',')==='c', 'delegatedByMe catches exactly the delegated task');
    assert(f.inboxTasks().map(t=>t.id).join(',')==='b' && f.myTasks().map(t=>t.id).join(',')==='a', 'inbox and my-tasks unchanged');
  }

  console.log('--- Static: wiring present in built files ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd.includes('id="pplAddTask"'), 'Add task button in person view');
    assert(gtd.includes('notes,priority,attachments'), 'person view query includes attachments');
    assert(/tasksapp-v\d+/.test(fs.readFileSync(path.join(ROOT,'tasks','sw.js'),'utf8')), 'tasks SW cache versioned');
  }

  console.log('--- Offline layer ---');
  {
    // sandbox with just OfflineService + CloudService extracted
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<body></body>', {url:'https://example.test/'});
    const w = dom.window;
    let netDown = false, posts = [];
    w.fetch = (url, opts) => {
      if(netDown) return Promise.reject(new TypeError('Failed to fetch'));
      if(opts && opts.method === 'POST'){ posts.push(String(url)); return Promise.resolve({ok:true, status:201, text:()=>Promise.resolve('')}); }
      return Promise.resolve({ok:true, status:200, text:()=>Promise.resolve('[{"id":"x1","title":"cached row"}]')});
    };
    const sandbox = {window:w, document:w.document, localStorage:w.localStorage, navigator:w.navigator,
      fetch:w.fetch, toast:()=>{}, console};
    sandbox.globalThis = sandbox;
    const vm = require('vm');
    const src = gtdSrc;
    const grab = (name) => {
      const ctx = vm.createContext(sandbox);
      return ctx;
    };
    // extract the OfflineService + CLOUD + CloudService definitions and run them
    const m = src.match(/const CLOUD = \{[\s\S]*?\n\};[\s\S]*?const CloudService = \{[\s\S]*?\n\};/);
    assert(m, 'offline/cloud source block found');
    const ctx = vm.createContext(sandbox);
    vm.runInContext(m[0], ctx);
    const OS = vm.runInContext('OfflineService', ctx);
    const CS = vm.runInContext('CloudService', ctx);
    CS.session = {access_token:'AT', user:{id:'me'}};

    // 1) GET caches, then serves from cache when the network dies
    const d1 = await CS.api('cloud_tasks?select=*');
    assert(Array.isArray(d1) && d1[0].id === 'x1', 'online GET returns rows');
    netDown = true;
    const d2 = await CS.api('cloud_tasks?select=*');
    assert(Array.isArray(d2) && d2[0].title === 'cached row', 'offline GET served from cache');
    assert(w.document.getElementById('offline-banner'), 'offline banner shown');

    // 2) additive POST queues offline and replays exactly once
    const r = await CS.api('cloud_tasks', {method:'POST', prefer:'return=minimal', body:{title:'queued task', owner_id:'me'}});
    assert(r === null, 'offline POST returns null (queued)');
    assert(OS.q().length === 1, 'task queued to outbox');
    assert(posts.length === 0, 'nothing hit the network while offline');
    netDown = false;
    await OS.replay();
    assert(OS.q().length === 0, 'outbox drained after replay');
    assert(posts.length === 1, 'queued task replayed exactly once');

    // 3) non-whitelisted POST does not queue
    netDown = true;
    let threw = false;
    try{ await CS.api('transactions', {method:'POST', prefer:'return=minimal', body:{amount:1}}); }catch(e){ threw = true; }
    assert(threw && OS.q().length === 0, 'non-whitelisted POST fails loudly rather than queuing');
  }

  console.log('--- Static: Next actions ranges + Calendar day mode ---');
  {
    const gtd = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd.includes('rangeBtn("day","Day")') && gtd.includes('rangeBtn("week","Week")') && gtd.includes('rangeBtn("month","Month")'), 'Day/Week/Month buttons in Next actions');
    assert(gtd.includes('data-nextrange]").forEach'), 'range buttons wired');
    assert(gtd.includes('data-calmode="day"'), 'Calendar has a Day mode button');
    assert(gtd.includes('AppState.calMode==="day"?1:'), 'calendar prev/next steps one day in day mode');
    assert(gtd.includes('return "Overdue"'), 'range views surface overdue items');
  }

  console.log('--- Static: range views in tasks app + people view ---');
  {
    const ta = fs.readFileSync(path.join(ROOT,'tasks','index.html'),'utf8');
    assert(ta.includes('data-range="day"')===false && ta.includes('["day","Day"]'), 'tasks app range buttons generated');
    assert(ta.includes('function rangeSpan()') && ta.includes('const inRange='), 'tasks app range helpers present');
    assert(ta.includes('dateGroupHTML(open.filter(inRange),true)') && ta.includes('dateGroupHTML(open.filter(inRange),false)'), 'both tabs honour the range');
    assert(ta.includes('[data-range]").forEach'), 'tasks app range buttons wired');
    const gtd2 = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd2.includes('data-pplrange') && gtd2.includes('[data-pplrange]").forEach'), 'people view range buttons present and wired');
    assert(gtd2.includes('pplInRange(t.due_date)'), 'people view cloud tasks filtered by range');
  }

  console.log('--- Static: tasks app calendar Day/Week/Month ---');
  {
    const ta2 = fs.readFileSync(path.join(ROOT,'tasks','index.html'),'utf8');
    assert(ta2.includes('CALVIEW="month"'), 'calendar view state defaults to month');
    assert(ta2.includes('data-calview="day"')===false && ta2.includes('[["day","Day"],["week","Week"],["month","Month"]]'), 'mode buttons generated');
    assert(ta2.includes('[data-calview]").forEach'), 'mode buttons wired');
    assert(ta2.includes('CALVIEW==="day"') && ta2.includes('CALVIEW==="week"'), 'day and week render branches present');
    assert(ta2.includes('if(CALVIEW==="day") d.setDate(d.getDate()+n)') && ta2.includes('d.setDate(d.getDate()+7*n)'), 'prev/next step by 1 day / 7 days / 1 month per mode');
  }

  console.log('--- Tasks app offline adds + Inbox capture ---');
  {
    const ta3 = fs.readFileSync(path.join(ROOT,'tasks','index.html'),'utf8');
    assert(ta3.includes('const TOffline={'), 'tasks app has an offline service');
    assert(ta3.includes('ta-outbox:'), 'outbox keyed per user');
    assert(ta3.includes('opts.body.owner_id===opts.body.assignee_id'), 'only self-assigned adds queue offline');
    assert(ta3.includes('_pending:true'), 'optimistic pending rows returned/rendered');
    assert(ta3.includes('TOffline.replay()'), 'replay wired');
    // Behavioural: queue then replay exactly once via extracted TOffline
    const { JSDOM } = require('jsdom');
    const vm = require('vm');
    const dom = new JSDOM('<body></body>', {url:'https://example.test/'});
    const w = dom.window;
    let posts = 0, netDown = true;
    w.fetch = (url, opts) => netDown ? Promise.reject(new TypeError('Failed to fetch'))
      : (posts++, Promise.resolve({ok:true, status:201, text:()=>Promise.resolve('')}));
    const m = ta3.match(/const TOffline=\{[\s\S]*?\n\};/);
    assert(m, 'TOffline block extractable');
    const sandbox = {window:w, document:w.document, localStorage:w.localStorage, navigator:w.navigator, fetch:w.fetch,
      toast:()=>{}, CLOUD:{url:'https://x.test', key:'k'}, Cloud:{session:{access_token:'AT', user:{id:'me'}}}, console, setTimeout, clearTimeout};
    sandbox.globalThis = sandbox;
    const ctx = vm.createContext(sandbox);
    vm.runInContext(m[0], ctx);
    const TO = vm.runInContext('TOffline', ctx);
    TO.queue({owner_id:'me', assignee_id:'me', title:'offline capture', status:'open', category:null});
    assert(TO.q().length === 1, 'task queued');
    netDown = false;
    // Regression: three concurrent replay triggers must not duplicate the task
    await Promise.all([TO.replay(), TO.replay(), TO.replay()]);
    assert(TO.q().length === 0 && posts === 1, 'queued task synced exactly once even under concurrent replays (posts=' + posts + ')');

    const gtd3 = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtd3.includes('capturedCloudIds'), 'capture dedupe ledger present');
    assert(gtd3.includes('!r.category') && gtd3.includes('status:"inbox"'), 'only uncategorised tasks captured, into Inbox');
    assert(gtd3.includes('source:"tasksapp"'), 'captured tasks carry provenance and cloud link');
  }

  console.log('--- Pipeline timeline demarcation ---');
  {
    const gtdT = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtdT.includes('function timelineMarked'), 'console has timeline marker helper');
    assert(gtdT.includes('timelineMarked(pending, x=>x.expectedDate, incRow)'), 'revenue list marked by month/week');
    assert(gtdT.includes('timelineMarked(outs, x=>x.dueDate, outRow)'), 'payments list marked by month/week');
    assert(gtdT.includes('.msep::before') && gtdT.includes('.wksep::before'), 'visual month bar and week tick styles present');
  }
  console.log('--- Outlook button actually fires from the drawer ---');
  {
    const { JSDOM } = require('jsdom');
    const gtdHtml = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    let opened = [];
    const dom = new JSDOM(gtdHtml, {runScripts:'dangerously', url:'https://example.test/',
      beforeParse(w){
        w.open = (u)=>{ opened.push(String(u)); return {focus(){}}; };
        w.fetch = ()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]'),json:()=>Promise.resolve({})});
      }});
    await new Promise(r=>setTimeout(r,600));
    const w = dom.window, d = w.document;
    // seed task store with a scheduled task and open its drawer
    w.eval('AppState').data = w.eval('demoData')();
    const TS = w.eval('TaskService');
    const task = TS.create({title:'CE+ call', status:'scheduled', scheduledDate:'2026-07-30', scheduledTime:'14:30', estimatedMinutes:45, notes:'prep'});
    w.eval('UI').taskDrawer(task.id);
    await new Promise(r=>setTimeout(r,150));
    const btn = d.getElementById('tdOutlook');
    assert(btn, 'Add to Outlook button rendered for the scheduled task');
    btn.click();
    await new Promise(r=>setTimeout(r,80));
    assert(opened.length === 1 && opened[0].includes('outlook.office.com/calendar/0/deeplink/compose'), 'click opens the Outlook compose deep link');
    assert(opened[0].includes(encodeURIComponent('2026-07-30T14:30:00')), 'link carries the scheduled date and time');
  }

  console.log('--- Scheduled time + Outlook ---');
  {
    const gtdO = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtdO.includes('id="tdSchedTime"') && gtdO.includes('scheduledTime:$("#tdSchedTime")'), 'time field present and saved');
    assert(gtdO.includes('function outlookComposeURL'), 'Outlook compose helper present');
    assert(gtdO.includes('outlook.office.com/calendar/0/deeplink/compose'), 'deep link targets Outlook compose');
    assert(gtdO.includes('id="tdOutlook"'), 'Add to Outlook button on scheduled tasks');
    assert(gtdO.includes('${t.scheduledTime?" "+esc(t.scheduledTime):""}'), 'time shown alongside scheduled date');
    // helper behaviour
    const vm = require('vm');
    const m = gtdO.match(/function outlookComposeURL[\s\S]*?\n\}/)[0];
    const ctx = vm.createContext({todayStr:()=> '2026-07-22', URLSearchParams});
    vm.runInContext(m, ctx);
    const url = vm.runInContext('outlookComposeURL({title:"CE+ call", notes:"prep", scheduledDate:"2026-07-30", scheduledTime:"14:30", estimatedMinutes:45})', ctx);
    assert(url.includes('subject=CE%2B+call') || url.includes('subject=CE'), 'subject carried');
    assert(url.includes('2026-07-30T14%3A30%3A00') || url.includes(encodeURIComponent('2026-07-30T14:30:00')), 'start uses scheduled date and time');
    assert(url.includes('15%3A15%3A00'), 'end = start + estimated minutes');
  }
  console.log('--- Mobile photo capture ---');
  {
    const gtdP = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtdP.includes('downscale and recompress'), 'large photos compressed, not rejected');
    assert(gtdP.includes('toDataURL("image/jpeg",0.82)') && gtdP.includes('MAX=1568'), 'canvas downscale to 1568px JPEG');
    assert(!gtdP.includes('is too large (max ~4.5 MB)'), 'hard 4.5MB rejection removed');
    assert(gtdP.includes('id="cmPhoto"'), 'photo shortcut in quick capture');
    assert(gtdP.includes('accept="image/*" multiple'), 'gallery/camera input retained');
  }
  console.log('--- All outstanding view ---');
  {
    const { JSDOM } = require('jsdom');
    const gtdHtml = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    const dom = new JSDOM(gtdHtml, {runScripts:'dangerously', url:'https://example.test/',
      beforeParse(w){ w.fetch=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]'),json:()=>Promise.resolve({})}); }});
    await new Promise(r=>setTimeout(r,600));
    const w=dom.window;
    w.eval('AppState').data = w.eval('demoData')();
    w.eval('CloudService').session = {access_token:'AT', user:{id:'me', email:'r@x.com'}};
    w.eval('TaskService').create({title:'Chase Brandon quote', status:'waiting', cloud:{id:'ct1', status:'open', comments:0}});
    const html2 = w.eval('UI').all();
    assert(html2.includes('All outstanding'), 'view renders with its title (signed in)');
    assert(html2.includes('Delegated — still open') && html2.includes('Chase Brandon quote'), 'open delegated tasks listed');
    assert((html2.match(/Chase Brandon quote/g)||[]).length === 1, 'delegated task not double-counted under Waiting');
    // Categorised groupings
    w.eval('AppState').allGroup='area';
    const byArea = w.eval('UI').all();
    assert(byArea.includes('data-allgroup="area"') && byArea.includes('No area') || /Cyber|Personal|Farm/.test(byArea), 'grouping by area renders area sections');
    w.eval('AppState').allGroup='priority';
    const byPri = w.eval('UI').all();
    const iC=byPri.indexOf('Critical'), iN=byPri.indexOf('Normal');
    assert(iC===-1||iN===-1||iC<iN, 'priority groups ordered Critical→Low');
    assert(byPri.indexOf('Overdue')===-1||byPri.indexOf('Overdue')<Math.max(iC,iN), 'Overdue stays pinned on top in every grouping');
    w.eval('AppState').allGroup='status';
    // Overdue prominence: create an overdue task, check it's flagged in every surface
    const ov = w.eval('TaskService').create({title:'Signing form for Trace', status:'next', dueDate:'2026-07-01', context:'@Home'});
    w.eval('go')('next');
    await new Promise(r=>setTimeout(r,150));
    let vhtml = w.document.getElementById('view').innerHTML;
    assert(vhtml.includes('OVERDUE') && vhtml.includes('Signing form for Trace'), 'overdue badge on the row in Next actions');
    assert(vhtml.includes('overdue-row'), 'overdue row visually highlighted');
    assert(/\d+d overdue — was due/.test(vhtml), 'overdue rows say how late and the original date');
    w.eval('go')('all');
    await new Promise(r=>setTimeout(r,150));
    vhtml = w.document.getElementById('view').innerHTML;
    assert(vhtml.includes('OVERDUE') && vhtml.includes('overdue-row'), 'same treatment in All outstanding');
    w.eval('go')('focus');
    await new Promise(r=>setTimeout(r,200));
    vhtml = w.document.getElementById('view').innerHTML;
    assert(vhtml.includes('Overdue — needs a decision') && vhtml.includes('Signing form for Trace'), 'Focus pins a red overdue section');
    const badge = w.document.getElementById('cntOverdue');
    assert(badge && badge.classList.contains('overdue') && Number(badge.textContent) >= 1, 'red overdue count on the All outstanding nav button');
    w.eval('TaskService').remove(ov.id);
    // Click-through in the rendered app: navigating to the view and clicking Area must re-render grouped
    const dApp = w.document;
    w.eval('go')('all');
    await new Promise(r=>setTimeout(r,150));
    const areaBtn = dApp.querySelector('#view [data-allgroup="area"]');
    assert(areaBtn, 'group buttons rendered in the live view');
    areaBtn.click();
    await new Promise(r=>setTimeout(r,150));
    assert(w.eval('AppState').allGroup === 'area', 'clicking a group button actually switches the grouping');
    assert(dApp.querySelector('#view [data-allgroup="area"]').classList.contains('primary'), 'active group highlighted after click');
    w.eval('AppState').allGroup='status';
    assert(html2.indexOf('Overdue') < html2.indexOf('Next actions') || !html2.includes('Overdue'), 'overdue section leads when present');
    assert(html2.includes('Inbox — unprocessed') || html2.includes('Next actions'), 'status sections present');
    assert(html2.includes('Someday/Maybe excluded'), 'someday parked, stated honestly');
    const gtdA = gtdHtml;
    assert(gtdA.includes('data-view="all"') && gtdA.includes('["all","All outstanding"]'), 'view reachable from sidebar and More tiles');
  }
  console.log('--- Next actions: context filter toggles ---');
  {
    const { JSDOM } = require('jsdom');
    const gtdHtml = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    const dom = new JSDOM(gtdHtml, {runScripts:'dangerously', url:'https://example.test/',
      beforeParse(w){ w.fetch=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]'),json:()=>Promise.resolve({})}); }});
    await new Promise(r=>setTimeout(r,600));
    const w=dom.window, d=w.document;
    w.eval('AppState').data = w.eval('demoData')();
    w.eval('setCtxFilter')([]);
    w.eval('AppState').nextRange='all';
    w.eval('go')('next');
    await new Promise(r=>setTimeout(r,200));
    let vh = d.getElementById('view').innerHTML;
    assert(vh.includes('id="ctxBar"'), 'context chip bar renders at the top of Next actions');
    assert(vh.includes('data-ctxchip="@Calls"') && vh.includes('data-ctxchip="@Computer"'), 'a chip per context in use');
    assert(vh.includes('data-ctxchip="__all__"'), 'an All chip is present');
    const allChip = d.querySelector('#view [data-ctxchip="__all__"]');
    assert(allChip && allChip.classList.contains('on'), 'All is selected when no filter set');

    // CLICK-THROUGH: the chip must actually filter the rendered list
    const before = d.querySelectorAll('#view .tasklist > .trow').length;
    const callsChip = d.querySelector('#view [data-ctxchip="@Calls"]');
    assert(callsChip, 'the @Calls chip is in the live DOM');
    callsChip.click();
    await new Promise(r=>setTimeout(r,200));
    assert(w.eval('ctxFilter()').indexOf('@Calls') >= 0, 'clicking a chip records the selection');
    vh = d.getElementById('view').innerHTML;
    const after = d.querySelectorAll('#view .tasklist > .trow').length;
    assert(after > 0 && after < before, 'list narrows to the chosen context (' + before + ' -> ' + after + ')');
    assert(!vh.includes('Draft the ISO 27001 scope statement'), 'a @Computer action is filtered out');
    assert(vh.includes('Call the borehole surveyor'), 'a @Calls action is retained');
    assert(d.querySelector('#view [data-ctxchip="@Calls"]').classList.contains('on'), 'chosen chip shown active after re-render');

    // multi-select is additive
    d.querySelector('#view [data-ctxchip="@Computer"]').click();
    await new Promise(r=>setTimeout(r,200));
    assert(w.eval('ctxFilter()').length === 2, 'chips multi-select rather than replace');
    const both = d.querySelectorAll('#view .tasklist > .trow').length;
    assert(both > after, 'selecting a second context widens the list');

    // persistence + guarded restore
    assert(JSON.parse(w.localStorage.getItem('gtdcc-ctxfilter')).length === 2, 'selection persisted to localStorage');
    w.localStorage.setItem('gtdcc-ctxfilter', '{"not":"an array"}');
    w.eval('AppState').ctxFilter = null;
    assert(Array.isArray(w.eval('ctxFilter()')) && w.eval('ctxFilter()').length === 0, 'corrupt persisted filter falls back to empty, never throws');

    // Clear returns everything
    w.eval('setCtxFilter')(['@Calls']);
    w.eval('render')();
    await new Promise(r=>setTimeout(r,200));
    const clr = d.getElementById('ctxClear');
    assert(clr, 'Clear button appears while a filter is active');
    clr.click();
    await new Promise(r=>setTimeout(r,200));
    assert(w.eval('ctxFilter()').length === 0, 'Clear resets the filter');
    assert(d.querySelectorAll('#view .tasklist > .trow').length === before, 'full list restored after clearing');
  }

  console.log('--- Subtasks: convert a task into a subtask of another ---');
  {
    const { JSDOM } = require('jsdom');
    const gtdHtml = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    const dom = new JSDOM(gtdHtml, {runScripts:'dangerously', url:'https://example.test/',
      beforeParse(w){ w.fetch=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]'),json:()=>Promise.resolve({})}); }});
    await new Promise(r=>setTimeout(r,600));
    const w=dom.window, d=w.document;
    w.eval('AppState').data = w.eval('demoData')();
    w.eval('setCtxFilter')([]);
    w.eval('AppState').nextRange='all';
    const TS = w.eval('TaskService');
    const shop = TS.create({title:'Go to the farm shop', status:'next', clarified:true, context:'@Errands'});
    const milk = TS.create({title:'Buy dip for the cattle', status:'next', clarified:true, context:'@Errands'});

    assert(TS.get(shop.id).parentId === null, 'new tasks start standalone');
    assert(TS.makeChild(milk.id, shop.id), 'a task can be converted into a subtask of another');
    assert(TS.get(milk.id).parentId === shop.id, 'parent recorded on the child');
    assert(TS.children(shop.id).length === 1, 'parent lists its child');

    // one level only — no cycles, no chains
    const deeper = TS.create({title:'Ask about the price', status:'next'});
    assert(!TS.canBeChildOf(deeper.id, milk.id), 'a subtask cannot itself take subtasks');
    assert(!TS.canBeChildOf(shop.id, milk.id), 'a parent cannot be nested under its own child');
    assert(!TS.canBeChildOf(shop.id, shop.id), 'a task cannot be its own parent');
    TS.remove(deeper.id);

    // hidden from the top-level lists, counted under the parent
    w.eval('go')('next');
    await new Promise(r=>setTimeout(r,200));
    let vh = d.getElementById('view').innerHTML;
    assert(vh.includes('Go to the farm shop'), 'the parent shows in Next actions');
    assert(!vh.includes('Buy dip for the cattle'), 'the subtask is not listed separately while collapsed');
    assert(vh.includes('data-subtog="'+shop.id+'"'), 'parent row carries a subtask toggle');
    assert(vh.includes('0/1'), 'toggle shows subtask progress');

    // CLICK-THROUGH: expand reveals the checklist and the inline add box
    d.querySelector('#view [data-subtog="'+shop.id+'"]').click();
    await new Promise(r=>setTimeout(r,200));
    vh = d.getElementById('view').innerHTML;
    assert(w.eval('AppState').expanded[shop.id] === true, 'toggle records the expanded state');
    assert(vh.includes('Buy dip for the cattle'), 'expanding reveals the subtask');
    assert(d.querySelector('#view [data-subadd="'+shop.id+'"]'), 'inline add box present under the parent');

    // CLICK-THROUGH: add a checklist item straight from the list
    const inp = d.querySelector('#view [data-subadd="'+shop.id+'"]');
    inp.value = 'Buy fencing staples';
    inp.dispatchEvent(new w.KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
    await new Promise(r=>setTimeout(r,220));
    assert(TS.children(shop.id).length === 2, 'inline add creates a real subtask');
    const staples = TS.children(shop.id).find(k=>k.title==='Buy fencing staples');
    assert(staples && staples.context === '@Errands', 'new subtask inherits the parent context');
    assert(d.getElementById('view').innerHTML.includes('Buy fencing staples'), 'new subtask renders immediately');

    // completing the parent closes the list under it, undoably
    TS.complete(shop.id);
    assert(TS.children(shop.id).every(k=>k.status==='completed'), 'completing the parent completes its open subtasks');
    TS.update(shop.id,{status:'next',completedAt:null});
    TS.children(shop.id).forEach(k=>TS.update(k.id,{status:'next',completedAt:null}));

    // deleting a parent must not orphan children
    const doomed = TS.create({title:'Temp parent', status:'next'});
    const kid = TS.create({title:'Temp child', status:'next', parentId:doomed.id});
    TS.remove(doomed.id);
    assert(TS.get(kid.id) && TS.get(kid.id).parentId === null, 'children of a deleted parent become standalone, not orphans');
    TS.remove(kid.id);

    // counts and other roll-ups exclude subtasks
    const nextCount = TS.byStatus('next').filter(t=>!TS.isChild(t)).length;
    w.eval('render')();
    await new Promise(r=>setTimeout(r,150));
    const badge = d.getElementById('cntNext');
    assert(badge && Number(badge.textContent) === nextCount, 'the Next actions badge counts parents only');
    const allHtml = w.eval('UI').all();
    assert(!allHtml.includes('Buy dip for the cattle'), 'All outstanding lists the parent, not its checklist items');

    // drawer: parent banner, child list, detach, and the picker
    w.eval('UI').taskDrawer(milk.id);
    await new Promise(r=>setTimeout(r,150));
    let dh = d.getElementById('modalHost').innerHTML;
    assert(dh.includes('Subtask of') && dh.includes('Go to the farm shop'), 'drawer states which task it sits under');
    assert(d.getElementById('tdDetach'), 'Make standalone button offered on a subtask');
    d.getElementById('tdDetach').click();
    await new Promise(r=>setTimeout(r,150));
    assert(TS.get(milk.id).parentId === null, 'detach returns the task to the top level');

    w.eval('UI').taskDrawer(milk.id);
    await new Promise(r=>setTimeout(r,150));
    const subOf = d.getElementById('tdSubOf');
    assert(subOf, 'standalone task offers "Make subtask of…"');
    subOf.click();
    await new Promise(r=>setTimeout(r,200));
    dh = d.getElementById('modalHost').innerHTML;
    assert(dh.includes('a subtask of'), 'picker modal opens');
    const pick = d.querySelector('#modalHost [data-pick="'+shop.id+'"]');
    assert(pick, 'the intended parent is offered in the picker');
    pick.click();
    await new Promise(r=>setTimeout(r,200));
    assert(TS.get(milk.id).parentId === shop.id, 'picking a parent converts the task into its subtask');

    // parent drawer: real children listed separately from the quick checklist
    w.eval('UI').taskDrawer(shop.id);
    await new Promise(r=>setTimeout(r,150));
    dh = d.getElementById('modalHost').innerHTML;
    assert(dh.includes('id="tdKids"') && dh.includes('Buy dip for the cattle'), 'parent drawer lists its subtasks');
    assert(dh.includes('id="tdNewKid"'), 'parent drawer can add another subtask');
    assert(dh.includes('Quick checklist') && dh.includes('id="tdSubs"'), 'the old lightweight checklist is retained alongside');
    assert(!dh.includes('id="tdSubOf"'), 'a task that already has subtasks is not offered as a child');
    const kidToggle = d.querySelector('#modalHost [data-kidtoggle]');
    assert(kidToggle, 'subtasks tickable from the parent drawer');
    kidToggle.click();
    await new Promise(r=>setTimeout(r,150));
    assert(TS.children(shop.id).some(k=>k.status==='completed'), 'ticking a subtask in the drawer completes it');
  }

  console.log('--- Delegation accepts any name, not just app accounts ---');
  {
    const { JSDOM } = require('jsdom');
    const gtdHtml = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(!gtdHtml.includes('No people have accounts yet'), 'the "no accounts" dead end is gone');
    assert(gtdHtml.includes('id="dlPerson" list="dlPeopleList"'), 'delegate modal uses a free-text input with suggestions');
    assert(!/<select id="dlPerson"/.test(gtdHtml), 'the fixed people dropdown is removed');
    assert(gtdHtml.includes('id="tdWPerson" list="tdPeopleList"'), 'drawer person field offers the same suggestions');

    const dom = new JSDOM(gtdHtml, {runScripts:'dangerously', url:'https://example.test/',
      beforeParse(w){ w.fetch=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]'),json:()=>Promise.resolve({})}); }});
    await new Promise(r=>setTimeout(r,600));
    const w=dom.window, d=w.document;
    w.eval('AppState').data = w.eval('demoData')();
    const TS=w.eval('TaskService');
    const CS=w.eval('CloudService');
    CS.session={access_token:'AT', user:{id:'me', email:'rodney@x.com'}};
    CS.peopleCache=[{id:'u1', email:'luke@x.com', display_name:'Luke'}];

    // name suggestions blend accounts with names already used in the app
    TS.create({title:'Old delegated thing', status:'waiting', waitingFor:{person:'Mark at the farm'}});
    const names = w.eval('peopleNames()');
    assert(names.includes('Luke'), 'account holders suggested');
    assert(names.includes('Mark at the farm'), 'names used before are suggested even without an account');
    assert(w.eval('matchAccount("luke@x.com")') && w.eval('matchAccount("Luke")'), 'account matched by name or email');
    assert(w.eval('matchAccount("Mark at the farm")') === null, 'a non-account name matches nothing, and that is fine');

    // CLICK-THROUGH: delegate to somebody with no account
    const chore = TS.create({title:'Fix the borehole pump', status:'next', clarified:true});
    w.eval('openDelegateModal')(chore.id);
    await new Promise(r=>setTimeout(r,200));
    const inp = d.getElementById('dlPerson');
    assert(inp && inp.tagName === 'INPUT', 'delegate field is a free-text input');
    assert(d.getElementById('dlPeopleList'), 'suggestion list rendered');
    inp.value = 'Tendai the plumber';
    inp.dispatchEvent(new w.Event('input', {bubbles:true}));
    await new Promise(r=>setTimeout(r,80));
    assert(/No app account/.test(d.getElementById('dlHint').textContent), 'the modal says plainly it will be tracked locally');
    assert(/waiting/i.test(d.getElementById('dlSend').textContent), 'the button relabels to match what will happen');
    d.getElementById('dlNote').value = 'Bring the 3 inch fittings';
    d.getElementById('dlDue').value = '2026-08-14';
    d.getElementById('dlSend').click();
    await new Promise(r=>setTimeout(r,200));
    const done = TS.get(chore.id);
    assert(done.status === 'waiting', 'task moves to Waiting for');
    assert(done.waitingFor.person === 'Tendai the plumber', 'the typed name is recorded verbatim');
    assert(done.waitingFor.expectedDate === '2026-08-14', 'due date carried onto the waiting record');
    assert(done.notes === 'Bring the 3 inch fittings', 'the note is kept on the task');
    assert(!done.cloud, 'no cloud row created for someone without an account');

    // an account holder still gets the real cloud send
    let posted = null;
    CS.delegate = async (task, assigneeId, note, due) => { posted={assigneeId, note, due}; return {id:'ct9', status:'open'}; };
    w.eval('PushService').notify = ()=>{};
    const chore2 = TS.create({title:'Review the switch quotes', status:'next', clarified:true});
    w.eval('openDelegateModal')(chore2.id);
    await new Promise(r=>setTimeout(r,200));
    const inp2 = d.getElementById('dlPerson');
    inp2.value = 'Luke';
    inp2.dispatchEvent(new w.Event('input', {bubbles:true}));
    await new Promise(r=>setTimeout(r,80));
    assert(/app account/.test(d.getElementById('dlHint').textContent), 'a matching account is recognised');
    assert(/Send task/.test(d.getElementById('dlSend').textContent), 'button offers the real send');
    d.getElementById('dlSend').click();
    await new Promise(r=>setTimeout(r,250));
    assert(posted && posted.assigneeId === 'u1', 'cloud delegation still routes to the account id');
    assert(TS.get(chore2.id).cloud && TS.get(chore2.id).cloud.assignee === 'luke@x.com', 'cloud link recorded');

    // the drawer offers Delegate even when not signed in to the cloud
    CS.session = null;
    w.eval('UI').taskDrawer(TS.create({title:'Chase the fencing quote', status:'next'}).id);
    await new Promise(r=>setTimeout(r,150));
    assert(d.getElementById('tdDelegate'), 'Delegate offered offline — local delegation needs no account');
  }

  console.log('--- Smart capture: notes and free-text delegation ---');
  {
    const { JSDOM } = require('jsdom');
    const gtdHtml = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    const dom = new JSDOM(gtdHtml, {runScripts:'dangerously', url:'https://example.test/',
      beforeParse(w){ w.fetch=()=>Promise.resolve({ok:true,status:200,text:()=>Promise.resolve('[]'),json:()=>Promise.resolve({})}); }});
    await new Promise(r=>setTimeout(r,600));
    const w=dom.window, d=w.document;
    w.eval('AppState').data = w.eval('demoData')();
    w.eval('CloudService').session={access_token:'AT', user:{id:'me', email:'rodney@x.com'}};
    w.eval('CloudService').peopleCache=[{id:'u1', email:'luke@x.com', display_name:'Luke'}];
    const TS=w.eval('TaskService');
    const before = TS.all().length;

    w.eval('openSmartCapture')();
    await new Promise(r=>setTimeout(r,150));
    w.eval('renderSmartResults')({summary:'', tasks:[
      {title:'Send the ISO scope to the assessor', description:'They asked for it twice already', person:'Luke', suggested_status:'waiting', priority:'high', due_date:'2026-08-03'},
      {title:'Order cattle dip', description:'Two drums', person:'Tapiwa at the farm', priority:'normal'},
      {title:'Read the supplier questionnaire', description:'', priority:'low'}
    ]});
    await new Promise(r=>setTimeout(r,150));
    const html = d.getElementById('scResults').innerHTML;
    assert(html.includes('Delegated to'), 'each proposed task has a delegation field');
    assert(html.includes('Notes'), 'each proposed task has a notes field');
    assert(d.getElementById('scPeopleList'), 'name suggestions available in the review list');
    assert(d.getElementById('scPer0').value === 'Luke', 'a person the analysis found is pre-filled');
    assert(d.getElementById('scPer1').value === 'Tapiwa at the farm', 'a name with no account is pre-filled just the same');
    assert(d.getElementById('scPer2').value === '', 'nothing invented where no person was found');
    assert(d.getElementById('scN0').value === 'They asked for it twice already', 'notes pre-filled from the analysis');
    assert(d.getElementById('scN0').tagName === 'TEXTAREA', 'notes are editable, not static text');

    // edit before accepting: retype a name and a note
    d.getElementById('scPer2').value = 'Brandon';
    d.getElementById('scN2').value = 'Only the security annex matters';
    d.getElementById('scAdd').click();
    await new Promise(r=>setTimeout(r,200));
    const added = TS.all().slice(before);
    assert(added.length === 3, 'all three proposed tasks added');
    const iso = added.find(t=>/ISO scope/.test(t.title));
    assert(iso.status === 'waiting' && iso.waitingFor.person === 'Luke', 'account holder recorded as a delegation');
    assert(iso.notes === 'They asked for it twice already', 'notes saved onto the task');
    assert(iso.waitingFor.expectedDate === '2026-08-03', 'due date carried onto the waiting record');
    const dip = added.find(t=>/cattle dip/.test(t.title));
    assert(dip.status === 'waiting' && dip.waitingFor.person === 'Tapiwa at the farm', 'a name with no account still creates a real delegation');
    const quest = added.find(t=>/questionnaire/.test(t.title));
    assert(quest.status === 'waiting' && quest.waitingFor.person === 'Brandon', 'a name typed during review is decisive over the suggested status');
    assert(quest.notes === 'Only the security annex matters', 'a note typed during review is kept');
    assert(added.every(t=>(t.tags||[]).includes('smart-capture')), 'provenance retained');
  }

  console.log('--- Smart capture: long pastes are not silently truncated ---');
  {
    const scSrc = fs.readFileSync(path.join(ROOT,'supabase','functions','smart-capture','index.ts'),'utf8');
    assert(/max_tokens:\s*16000/.test(scSrc), 'response budget raised well above a long meeting-notes paste');
    assert(!/max_tokens:\s*2000\b/.test(scSrc), 'the old 2000-token ceiling is gone');
    assert(scSrc.includes('function extractArray'), 'partial-response salvage present');
    assert(scSrc.includes('stop_reason === "max_tokens"'), 'a completed-but-capped response is flagged truncated');
    assert(scSrc.includes('never stop early'), 'the prompt tells the model to extract every task');
    assert(scSrc.includes('under 20 words'), 'descriptions kept short so long lists fit');

    // Behavioural: the salvage helper, run against a genuinely truncated payload
    const vm = require('vm');
    const ctx = vm.createContext({JSON, console});
    const fn = scSrc.slice(scSrc.indexOf('function extractArray'), scSrc.indexOf('Deno.serve'))
      .replace(/:\s*Record<string, unknown>\[\]/g, '')
      .replace(/\(src: string, key: string\)/, '(src, key)')
      .replace(/\(src: string\): string/, '(src)');
    vm.runInContext(fn, ctx);
    const cut = '{"summary":"Four one-to-ones","tasks":[' +
      '{"title":"Spin up the endpoint PoC","description":"a"},' +
      '{"title":"Duplicate the VIP alert","description":"b"},' +
      '{"title":"Send Talon proposal","description":"note {ref} on file"},' +
      '{"title":"Fix the cracked domain admin passwo';
    const got = vm.runInContext('extractArray', ctx)(cut, 'tasks');
    assert(got.length === 3, 'complete tasks recovered from a truncated response (got ' + got.length + ')');
    assert(got[0].title === 'Spin up the endpoint PoC', 'first recovered task intact');
    assert(got[2].description.includes('{ref}'), 'a brace inside a string does not confuse the scanner');
    assert(vm.runInContext('extractSummary', ctx)(cut) === 'Four one-to-ones', 'summary recovered too');
    const whole = '{"tasks":[{"title":"A"},{"title":"B"}],"finance_payments":[{"name":"Rates"}]}';
    assert(vm.runInContext('extractArray', ctx)(whole, 'tasks').length === 2, 'intact payloads still read correctly');
    assert(vm.runInContext('extractArray', ctx)(whole, 'expenses').length === 0, 'a missing array yields nothing, not an error');
    const escd = '{"tasks":[{"title":"Say \\"hello\\" to Luke"},{"title":"Second"}]}';
    assert(vm.runInContext('extractArray', ctx)(escd, 'tasks').length === 2, 'escaped quotes do not end the string early');

    // The console must say so rather than quietly showing a short list
    const gtdSrc = fs.readFileSync(path.join(ROOT,'index.html'),'utf8');
    assert(gtdSrc.includes('CUT SHORT'), 'the review screen warns when the analysis was capped');
    assert(gtdSrc.includes('Proposed tasks (${tasks.length})'), 'the count is shown so a short list is obvious');
  }

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
