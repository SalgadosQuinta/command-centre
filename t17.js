const fs=require('fs');const {JSDOM}=require('jsdom');
const html=fs.readFileSync('index.html','utf8');
const dom=new JSDOM(html,{runScripts:"dangerously",url:"https://localhost/",pretendToBeVisual:true});
const w=dom.window;w.fetch=()=>Promise.reject(new Error("off"));
setTimeout(async()=>{
  const d=w.document,$=s=>d.querySelector(s);
  const click=el=>el&&el.dispatchEvent(new w.Event('click',{bubbles:true}));
  const type=(el,v)=>{el.value=v;el.dispatchEvent(new w.Event('input',{bubbles:true}));};
  click($('#setupDemo'));
  click(d.querySelector('.rail [data-view="finance"]'));
  console.log('no PIN yet -> open + Set PIN button:', $('#view').textContent.includes('Expected in') && $('#finPin').textContent.includes('Set PIN'));
  // set a PIN
  click($('#finPin'));
  $('#pinNew').value="4321";
  click($('#pinSave'));
  await new Promise(r=>setTimeout(r,300));
  console.log('pin stored as hash (not plaintext):', w.eval('AppState.data.settings.financePin')!=="4321" && w.eval('AppState.data.settings.financePin.length')===64);
  console.log('still unlocked this session:', $('#view').textContent.includes('Expected in'));
  // simulate fresh session
  w.eval('AppState.financeUnlocked=false'); w.eval('render()');
  console.log('locked on new session:', !!$('#pinEntry') && !$('#view').textContent.includes('Revenue pipeline'));
  type($('#pinEntry'),"9999");
  await new Promise(r=>setTimeout(r,250));
  console.log('wrong PIN rejected:', $('#pinMsg') && $('#pinMsg').textContent.includes('Wrong'));
  type($('#pinEntry'),"4321");
  await new Promise(r=>setTimeout(r,250));
  console.log('right PIN auto-unlocks on 4th digit:', $('#view').textContent.includes('Revenue pipeline'));
  // analysis: record salary received twice + a paid outgoing with category
  w.eval(`
    const inc=FinanceService.addIncome({name:"Salary",client:"Langham Hall",amount:8000,currency:"GBP",expectedDate:addDays(todayStr(),-35),recurring:"monthly"});
    FinanceService.markReceived(inc.id); // last month occurrence
    FinanceService.markReceived(inc.id); // this month occurrence
    const o1=FinanceService.addOutgoing({name:"Starlink",category:"Software",amount:100,currency:"GBP",dueDate:addDays(todayStr(),-5),recurring:"monthly"});
    FinanceService.markPaid(o1.id);
    render();
  `);
  const txt=$('#view').textContent;
  console.log('monthly analysis table with In/Out/Net:', txt.includes('Monthly in / out') && txt.includes('GBP 8000.00'));
  console.log('salary accumulates via receivedHistory:', w.eval('AppState.data.finance.income.find(i=>i.name==="Salary").receivedHistory.length')===2);
  console.log('category breakdown 90 days:', txt.includes('Where it goes') && txt.includes('Software'));
  // remove PIN with wrong current fails
  click($('#finPin'));
  $('#pinCur').value="1111"; $('#pinNew').value="";
  click($('#pinSave'));
  await new Promise(r=>setTimeout(r,250));
  console.log('change blocked with wrong current PIN:', !!w.eval('AppState.data.settings.financePin'));
  $('#pinCur').value="4321"; $('#pinNew').value="";
  click($('#pinSave'));
  await new Promise(r=>setTimeout(r,250));
  console.log('PIN removed with correct current:', w.eval('AppState.data.settings.financePin')===null);
},600);
