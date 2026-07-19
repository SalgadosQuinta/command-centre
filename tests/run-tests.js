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
    assert(gtd.includes('gtd_mobsec'), 'open section persisted');
    assert(gtd.includes('data-msec') && gtd.includes('data-mviews'), 'accordion sections wired');
    assert(gtd.includes('curGroup'), 'current view auto-opens its group');
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

  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
