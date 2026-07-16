h=open('index.html').read()

# ---- Weekly digest at the top of Review ----
o='''UI.review = function(){'''
assert h.count(o)==1
n='''function digestHTML(){
  const tStr=todayStr(); const weekAgo=addDays(tStr,-7);
  const tasks=TaskService.all();
  const done7=tasks.filter(t=>t.status==="completed"&&(t.completedAt||"").slice(0,10)>=weekAgo);
  const created7=tasks.filter(t=>(t.createdAt||"").slice(0,10)>=weekAgo);
  const h2=GTDService.health();
  const f=AppState.data.finance;
  const finBit=(f&&(f.income.length||f.outgoings.length)&&!financeLocked())
    ?(()=>{const i=FinanceService.expectedIn(30),o=FinanceService.committedOut(30);
      const fm=s=>Object.keys(s).map(c=>money(c,s[c])).join(" · ")||"—";
      return ` · expecting ${fm(i)} in / ${fm(o)} out over 30 days`;})():"";
  return `<div class="card" style="margin-bottom:16px;border-left:3px solid var(--accent)">
    <h2><span class="eyebrow">This week at a glance</span></h2>
    <div style="font-size:13px;color:var(--muted);line-height:1.7">
      <b style="color:var(--text)">${done7.length}</b> completed and <b style="color:var(--text)">${created7.length}</b> captured in the last 7 days ·
      <b style="color:${h2.overdue?"var(--danger)":"var(--text)"}">${h2.overdue}</b> overdue ·
      <b style="color:var(--text)">${TaskService.byStatus("waiting").length}</b> waiting on others ·
      <b style="color:${h2.noNext?"var(--warn)":"var(--text)"}">${h2.noNext}</b> project${h2.noNext===1?"":"s"} without a next action${esc(finBit)}
    </div>
    ${done7.length?`<div class="grouphead"><span class="eyebrow">Completed this week</span></div>
      <div style="opacity:.75">${done7.slice(0,8).map(t=>`<div style="padding:4px 0;font-size:12.5px;color:var(--faint)">✓ ${esc(t.title)}</div>`).join("")}${done7.length>8?`<div class="mono" style="font-size:10.5px;color:var(--faint)">…and ${done7.length-8} more</div>`:""}</div>`:""}
  </div>`;
}
UI.review = function(){'''
h=h.replace(o,n)

# insert digest into review view output — find review viewhead end
import re
m=re.search(r'(UI\.review = function\(\)\{[\s\S]{0,800}?</div></div>)',h)
assert m, "review head not found"
h=h[:m.end()]+'\n  ${digestHTML()}'+h[m.end():]

open('index.html','w').write(h)
print("digest ok")
