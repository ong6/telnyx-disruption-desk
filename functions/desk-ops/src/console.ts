// The ops console: one self-contained page that polls /api/state every 2 seconds.
export const CONSOLE_HTML = /* html */ `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Nimbus Air · Disruption Desk</title>
<style>
:root{--bg:#0d1014;--panel:#151a21;--line:#252d38;--ink:#e8e3d6;--dim:#8a93a0;--amber:#ffb627;--red:#ff5a4e;--green:#4fd18b;--blue:#6cb6ff;
--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,sans-serif}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 var(--sans)}
header{display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--line);background:#0a0c10}
h1{font:600 15px var(--mono);letter-spacing:.14em;text-transform:uppercase;margin:0;color:var(--amber)}
.pill{font:600 11px var(--mono);letter-spacing:.08em;padding:4px 9px;border-radius:3px;border:1px solid var(--line);text-transform:uppercase}
.on{color:#111;background:var(--red);border-color:var(--red)}.ok{color:#08130c;background:var(--green);border-color:var(--green)}.warn{color:#111;background:var(--amber);border-color:var(--amber)}
main{display:grid;grid-template-columns:repeat(12,1fr);gap:14px;padding:16px 20px;max-width:1500px;margin:0 auto}
section{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:14px 16px;min-width:0}
h2{font:600 11px var(--mono);letter-spacing:.14em;text-transform:uppercase;color:var(--dim);margin:0 0 10px}
.kpis{grid-column:span 12;display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;background:none;border:0;padding:0}
.kpi{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:12px 14px}
.kpi b{display:block;font:600 26px var(--mono);font-variant-numeric:tabular-nums}.kpi span{color:var(--dim);font-size:12px}
.board{grid-column:span 7}.side{grid-column:span 5}.wide{grid-column:span 12}
table{width:100%;border-collapse:collapse;font:13px var(--mono);font-variant-numeric:tabular-nums}
th{text-align:left;color:var(--dim);font-weight:500;font-size:11px;letter-spacing:.08em;text-transform:uppercase;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:7px 8px;border-bottom:1px solid #1c232c;white-space:nowrap}
.cancelled{color:var(--red)}.scheduled{color:var(--green)}.delayed{color:var(--amber)}
.bar{height:6px;background:#222a35;border-radius:3px;overflow:hidden;min-width:90px}.bar i{display:block;height:100%;background:var(--amber)}
button,input,select{font:600 12px var(--mono);background:#1d242e;color:var(--ink);border:1px solid #2f3a48;border-radius:4px;padding:7px 10px;cursor:pointer}
button:hover{border-color:var(--amber)}button.danger{border-color:#5a2a27}input{cursor:text;width:100%}
.controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.controls+.controls{margin-top:8px}
.mut{color:var(--dim)}a{color:var(--blue);cursor:pointer;text-decoration:none}
.trunc{max-width:260px;overflow:hidden;text-overflow:ellipsis}
.help{font-size:12px;color:var(--dim);margin:6px 0 2px;line-height:1.5}.help b{color:var(--ink);font-weight:600}
.surge{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-top:8px}.surge div{background:#10141a;border:1px solid var(--line);border-radius:4px;padding:8px}.surge b{display:block;font:600 18px var(--mono)}.surge span{font-size:11px;color:var(--dim)}
.prog{height:6px;background:#222a35;border-radius:3px;overflow:hidden;margin-top:8px}.prog i{display:block;height:100%;background:var(--green)}
.wf{position:relative;height:22px;margin:3px 0;font:12px var(--mono)}.wf i{position:absolute;top:3px;height:16px;border-radius:2px;background:var(--blue);opacity:.85}
.wf i.error{background:var(--red)}.wf i.hit{background:var(--green)}.wf span{position:absolute;left:0;top:2px;white-space:nowrap;color:var(--ink);text-shadow:0 0 4px #000}
.spark{display:flex;gap:2px;align-items:flex-end;height:20px}.spark i{width:5px;background:var(--green);border-radius:1px}.spark i.bad{background:var(--red)}
#toast{position:fixed;bottom:16px;right:16px;background:#1d242e;border:1px solid var(--amber);padding:10px 14px;border-radius:4px;font:12px var(--mono);display:none}
.lives{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:10px}
.live{background:#10141a;border:1px solid var(--line);border-radius:4px;padding:10px 12px;font:12px var(--mono);overflow:hidden}
.live.solo{grid-column:1/-1}
.live .hd{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.tl{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dim)}
.tl b{color:var(--ink);font-weight:600}
.tl.err{color:var(--red)}.tl.hit{color:var(--green)}
button.busy,a.busy{opacity:.55;pointer-events:none}
#busy{display:none}
@media (max-width:900px){.board,.side{grid-column:span 12}main{padding:12px}header{padding:12px}}
</style></head><body>
<header><h1>Nimbus Air · Disruption Desk</h1><span id="mode" class="pill">—</span><span id="queue" class="pill">—</span><span id="handoff" class="pill">—</span><span id="fault" class="pill" style="display:none"></span><span id="health" class="pill">canary —</span><span id="busy" class="pill warn">working…</span><span id="state" class="pill" title="How long the console took to read its own state, and which subsystems failed to answer">console —</span><span id="scn" class="mut"></span></header>
<main>
<section class="wide" style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between">
<div><h2 style="margin:0 0 6px">Talk to the desk</h2><div class="mut">Call from this browser (allow the microphone). Phone: +1 743 888 2787 (trial account: only the verified number can dial in).
<br>Web calls are treated as the demo passenger, Jun (booking K7Q2ZX), while <b>web calls as demo caller</b> is on; turn it off to verify with a booking from the README.</div></div>
<telnyx-ai-agent agent-id="assistant-dbc59018-c2bb-437f-86bd-1030a9c5271b"></telnyx-ai-agent>
</section>
<div class="kpis" id="kpis"></div>
<section class="wide"><h2>Live calls <span id="livepills" class="mut"></span></h2><div id="live" class="lives"></div></section>
<section class="board"><h2>Departures · Singapore → Hong Kong</h2><table><thead><tr><th>Flight</th><th>Date</th><th>Dep</th><th>Status</th><th>Seats left</th><th>Held</th><th>Waitlist</th><th></th><th></th></tr></thead><tbody id="flights"></tbody></table></section>
<section class="side"><h2>Demo</h2>
<div class="controls op"><button onclick="act('/api/scenario',{id:'normal'},this)" title="All flights on time; FAQs and voluntary changes">Normal day</button><button class="danger" onclick="influx(this)" title="Typhoon cancels today's Hong Kong flights, then 200 simulated passengers call to rebook over 30 s">Influx day: typhoon + 200 callers</button></div>
<div id="surgebox" class="mut" style="font:12px var(--mono);margin-top:6px">No surge run yet.</div>
<div id="lock" class="help"></div>
<details class="op" style="margin-top:10px"><summary class="help" style="cursor:pointer">More controls</summary>
<div class="help"><b>Human queue full</b>: callers asking for a person get a callback offer instead of a transfer. <b>Relief flight</b>: ops adds a 300-seat NB870 tomorrow. <b>Hold length</b>: how long a held seat waits for a yes (45 s shows expiry live). <b>Web calls as Jun</b>: browser calls are recognised as the demo passenger. <b>free 1</b> on the board frees a seat so a waitlisted passenger gets a callback.</div>
<div class="controls"><button onclick="flag('human_queue',this)">Toggle human queue</button><button onclick="flag('handoff',this)">Toggle handoff (transfer / end call)</button><button onclick="flag('fault',this)">Break MCP (fault)</button><button onclick="act('/api/relief',{},this)">+ Relief flight NB870</button>
<select id="ttl" onchange="act('/api/flags',{hold_ttl_secs:Number(this.value)},this)"><option value="600">hold 10 min</option><option value="120">hold 2 min</option><option value="45">hold 45 s</option></select>
<button onclick="flag('web_calls_as_demo_caller',this)">Toggle web calls as Jun</button><button onclick="act('/api/metrics/reset',{},this)">Reset counters</button></div>
</details>
<h2 style="margin-top:16px">Canary · last 30 minutes</h2><div class="spark" id="spark"></div><div class="mut" id="canarytxt" style="font:12px var(--mono);margin-top:6px"></div>
<h2 style="margin-top:16px">Latency p50 / p95 (15 min)</h2><table><tbody id="lat"></tbody></table></section>
<section class="board"><h2>Recent calls</h2><table><thead><tr><th>Trace</th><th>Started</th><th>Caller</th><th>Booking</th><th>Last step</th><th>Outcome</th></tr></thead><tbody id="calls"></tbody></table></section>
<section class="side"><h2>Passengers</h2><table><thead><tr><th>Booking</th><th>Pax</th><th>Case</th><th>Detail</th></tr></thead><tbody id="trips"></tbody></table>
<h2 style="margin-top:16px">Human callback queue</h2><table><tbody id="cbs"></tbody></table></section>
<section class="wide"><h2>Trace <span id="tid" class="mut"></span></h2><div id="trace" class="mut">Click a trace id to see one call's path: assistant → webhook → KV / actor → MCP → reservation system.</div></section>
</main><div id="toast"></div>
<script async src="https://unpkg.com/@telnyx/ai-agent-widget@0.36.0"></script>
<script>
const $=id=>document.getElementById(id);let KEY='';
try{const m=location.hash.match(/key=([^&]+)/);if(m){localStorage.setItem('desk-key',decodeURIComponent(m[1]));history.replaceState(null,'',location.pathname)}KEY=localStorage.getItem('desk-key')||''}catch(e){}
let S=null;const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=t=>{const s=Math.round((Date.now()-t)/1000);return s<60?s+'s ago':Math.round(s/60)+'m ago'};
function toast(m){const t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',3500)}
let busyN=0;
function busy(n){const b=$('busy');if(!b)return;busyN=Math.max(0,busyN+n);b.style.display=busyN?'':'none';if(busyN>1)b.textContent='working ×'+busyN;else b.textContent='working…'}
const DONE={'/api/scenario':'scenario loaded','/api/surge':'surge started','/api/relief':'relief flight added','/api/release':'seat freed','/api/flags':'flag updated','/api/metrics/reset':'counters reset'};
async function act(path,body,el,label){
  const keep=el?(el.dataset.label||(el.dataset.label=el.textContent)):null;
  const isSelect=el&&el.tagName==='SELECT';
  if(el){el.disabled=true;el.classList.add('busy');if(!isSelect)el.textContent=label||'Working…'}
  busy(1);
  const t0=Date.now();
  try{
    const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+KEY},body:JSON.stringify(body)});
    const j=await r.json().catch(()=>({}));
    if(r.ok){const extra=path==='/api/scenario'&&body&&body.id?' ('+body.id+')':'';toast((DONE[path]||'done') + extra + (Date.now()-t0>1500?' · '+Math.round((Date.now()-t0)/100)/10+' s':''))}
    else toast(r.status===401?'Operator key required: open the operator link (scripts/console-link.mjs)':'error: '+(j.error||r.status));
  }catch(e){toast('error: '+e)}
  busy(-1);
  if(el){el.disabled=false;el.classList.remove('busy');if(!isSelect)el.textContent=keep;delete el.dataset.label}
  load();
}
async function influx(el){
  const keep=el.dataset.label||(el.dataset.label=el.textContent);
  el.disabled=true;el.classList.add('busy');
  el.textContent='Loading typhoon…';
  await act('/api/scenario',{id:'typhoon'});
  el.textContent='Starting 200 callers…';
  await act('/api/surge',{callers:200,seconds:30});
  el.disabled=false;el.classList.remove('busy');el.textContent=keep;delete el.dataset.label;
}
function flag(name,el){const cur=S&&S.flags?S.flags[name]:undefined;const next=name==='human_queue'?(cur==='full'?'open':'full'):name==='handoff'?(cur==='end_call'?'transfer':'end_call'):name==='fault'?(cur==='mcp_down'?'off':'mcp_down'):(cur==='on'?'off':'on');act('/api/flags',{[name]:next},el,'Flipping '+name+'…')}
function sum(c,pred){return Object.entries(c).filter(([k])=>pred(k)).reduce((n,[,v])=>n+v,0)}
function render(s){S=s;const f=s.flags;
const st=s.stateMs||0;$('state').textContent='console '+Math.round(st/100)/10+' s'+(s.degraded?' · degraded: '+s.degraded.join(', '):'');$('state').className='pill '+(s.degraded?'on':(st>4000?'warn':''));
$('mode').textContent='disruption '+f.disruption_mode;$('mode').className='pill '+(f.disruption_mode==='on'?'on':'');
$('queue').textContent='human queue '+f.human_queue;$('queue').className='pill '+(f.human_queue==='full'?'warn':'');
$('handoff').textContent='handoff '+f.handoff;$('handoff').className='pill '+(f.handoff==='end_call'?'warn':'');
const brk=f.fault&&f.fault!=='off';$('fault').style.display=brk?'':'none';if(brk){$('fault').textContent='FAULT '+f.fault;$('fault').className='pill on'}
$('scn').textContent=(s.scenario?('scenario: '+s.scenario.id+' · base '+s.scenario.baseDate+' · hold '+f.hold_ttl_secs+'s'):'no scenario loaded')+' · web calls as demo caller: '+f.web_calls_as_demo_caller;
const runs=(s.canary&&s.canary.runs)||[];const last=runs[0];const fresh=last&&Date.now()-last.at<90000;const good=last&&last.dv.ok&&last.mcpList.ok&&last.mcpTool.ok;
$('health').textContent=!s.canary.running?'canary off':(fresh&&good?'healthy · '+ago(last.at):'UNHEALTHY');$('health').className='pill '+(!s.canary.running?'':(fresh&&good?'ok':'on'));
$('spark').innerHTML=runs.slice().reverse().map(r=>{const ok=r.dv.ok&&r.mcpList.ok&&r.mcpTool.ok;const h=Math.min(20,4+Math.max(r.dv.ms,r.mcpTool.ms)/150);return '<i class="'+(ok?'':'bad')+'" style="height:'+h+'px" title="'+new Date(r.at).toLocaleTimeString()+' dv '+r.dv.ms+'ms tool '+r.mcpTool.ms+'ms"></i>'}).join('');
$('canarytxt').textContent=last?('last probe '+ago(last.at)+' · webhook '+last.dv.ms+'ms · tools/list '+last.mcpList.ms+'ms · tool call '+last.mcpTool.ms+'ms'+(good?'':' · '+([last.dv,last.mcpList,last.mcpTool].find(p=>!p.ok)||{}).detail)):'no probes yet';
const c=(s.metrics&&s.metrics.counts)||{};const calls=sum(c,k=>k.startsWith('dv:webhook:'));
const k=[['Calls (15 min)',calls],['Rebooked',(s.metrics&&sum(s.metrics.counts||{},k2=>k2==='mcp:tool:confirm_rebooking:ok'))||0],['Refunded',(s.metrics&&sum(s.metrics.counts||{},k2=>k2==='mcp:tool:request_refund:ok'))||0],['Waitlisted',(s.metrics&&sum(s.metrics.counts||{},k2=>k2==='mcp:tool:join_waitlist:ok'))||0],
['Seat races lost',(s.metrics&&sum(s.metrics.counts||{},k2=>k2==='mcp:tool:hold_seats:declined'))||0],['Tool errors (1 min)',(s.metrics&&s.metrics.errorsLastMinute)||0],['Seats left (HKG)',(s.flights||[]).filter(x=>x.status!=='cancelled').reduce((n,x)=>n+x.seatsLeft,0)]];
$('kpis').innerHTML=k.map(([l,v])=>'<div class="kpi"><b'+(l.startsWith('Tool errors')&&v>0?' style="color:var(--red)"':'')+'>'+v+'</b><span>'+l+'</span></div>').join('');
$('flights').innerHTML=s.flights.map(x=>{const pct=x.capacity?Math.round(100*(x.capacity-x.seatsLeft)/x.capacity):0;return '<tr><td>'+x.number+'</td><td>'+x.date.slice(5)+'</td><td>'+x.dep+'</td><td class="'+x.status+'">'+x.status.toUpperCase()+'</td><td>'+x.seatsLeft+'</td><td>'+x.held+'</td><td>'+x.waitlist+'</td><td><div class="bar"><i style="width:'+pct+'%"></i></div></td><td>'+(x.status!=='cancelled'&&KEY?'<a title="simulate another passenger freeing a seat" onclick="act(\\'/api/release\\',{flightId:\\''+x.id+'\\',seats:1},this)">free 1</a>':'')+'</td></tr>'}).join('');
$('lat').innerHTML=Object.entries((s.metrics&&s.metrics.latency)||{}).sort().map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+v.p50+' / '+v.p95+' ms</td><td class="mut">n='+v.n+'</td></tr>').join('')||'<tr><td class="mut">no traffic yet</td></tr>';
$('calls').innerHTML=((s.metrics&&s.metrics.calls)||[]).map(r=>'<tr><td><a data-tid="'+esc(r.trace)+'" onclick="showTrace(this.dataset.tid)">'+esc(r.trace)+'</a></td><td>'+ago(r.at)+'</td><td>'+esc(r.caller||'web')+'</td><td>'+esc(r.booking||'—')+'</td><td>'+esc(r.last)+'</td><td>'+esc(r.outcome)+'</td></tr>').join('')||'<tr><td class="mut" colspan=6>no calls yet</td></tr>';
$('trips').innerHTML=(s.trips||[]).map(t=>{const d=t.rebookedTo?t.rebookedTo.flightId+' · '+t.rebookedTo.confirmation:t.hold&&t.hold.expiresAt>Date.now()?'holding '+t.hold.flightId+' · '+Math.round((t.hold.expiresAt-Date.now())/1000)+'s':t.refund?t.refund.reference:t.waitlist?'waitlist '+t.waitlist.flightId+(t.callback?' · callback '+(t.callback.placedAt?'placed '+esc(t.callback.result):'due'):''):'';return '<tr><td>'+esc(t.code)+'</td><td>'+t.pax+'</td><td>'+esc(t.status)+'</td><td class="mut trunc" title="'+esc(d)+'">'+esc(d)+'</td></tr>'}).join('');}
function renderLock(){
  document.querySelectorAll('.op').forEach(e=>{e.style.display=KEY?'':'none'});
  $('lock').textContent=KEY?'':'Read-only view — the demo controls live in the operator\\'s link (scripts/console-link.mjs).';
}
function renderSurge(s){const g=s.surge;if(!g||g.total==null){return}const pct=g.total?Math.round(100*g.done/g.total):0;const el=((g.finishedAt||Date.now())-g.startedAt)/1000;
$('surgebox').innerHTML=(g.running?'Surge running':'Last surge')+': '+g.done+' / '+g.total+' passengers in '+el.toFixed(0)+' s ('+(g.done/Math.max(1,el)).toFixed(1)+'/s)'+'<div class="prog"><i style="width:'+pct+'%"></i></div><div class="surge"><div><b>'+g.rebooked+'</b><span>rebooked</span></div><div><b>'+g.waitlisted+'</b><span>waitlisted + callback</span></div><div><b>'+g.raceLost+'</b><span>seat races lost, retried</span></div><div><b>'+g.errors+'</b><span>errors</span></div><div><b>'+g.p50+' / '+g.p95+'</b><span>ms per passenger p50 / p95</span></div></div>'}
function renderCbs(s){$('cbs').innerHTML=(s.callbacks||[]).map(c=>'<tr><td>'+ago(c.at)+'</td><td>'+esc(c.booking||c.caller||'unknown')+'</td><td class="mut trunc" title="'+esc(c.reason)+'">'+esc(c.reason)+'</td><td><a data-tid="'+esc(c.trace)+'" onclick="showTrace(this.dataset.tid)">trace</a></td></tr>').join('')||'<tr><td class="mut">empty</td></tr>'}
let liveCache={};
async function tickLive(){
  const box=$('live');if(!box)return;
  const calls=(S&&S.metrics&&S.metrics.calls)||[];
  const actives=calls.filter(c=>(!c.outcome||c.outcome==='in_progress')&&Date.now()-c.at<300000).slice(0,4);
  if(!actives.length){box.innerHTML='<div class="mut" style="font:12px var(--mono)">No live calls — start one with the widget above, the phone line, or the influx button.</div>';liveCache={};$('livepills').textContent='';return}
  $('livepills').textContent=actives.length+' active · updates every 3 s';
  const solo=actives.length===1;
  const panels=await Promise.all(actives.map(async c=>{
    const r=await fetch('/api/trace/'+encodeURIComponent(c.trace),{headers:{authorization:'Bearer '+KEY}}).then(x=>x.json()).catch(()=>null);
    const spans=(r&&r.spans)||[];
    liveCache[c.trace]=spans;
    const t0=spans.length?Math.min(...spans.map(x=>x.at-(x.ms||0))):0;
    const lines=spans.slice(-(solo?14:6)).map(x=>{const cls=x.outcome==='error'?'err':x.outcome==='hit'?'hit':'';return '<div class="tl '+cls+'">+'+Math.max(0,(x.at-(x.ms||0))-t0)+'ms <b>'+esc(x.svc)+' '+esc(x.op)+'</b> · '+esc(x.outcome)+(x.detail?' · '+esc(x.detail):'')+'</div>'}).join('')||'<div class="tl mut">waiting for the first span…</div>';
    return '<div class="live'+(solo?' solo':'')+'"><div class="hd"><span class="pill ok">LIVE</span><a data-tid="'+esc(c.trace)+'" onclick="showTrace(this.dataset.tid)">'+esc(c.trace)+'</a><span class="pill">'+esc(c.booking||'web')+'</span><span class="mut">'+esc(c.caller||'')+'</span><span class="mut">'+esc(c.last||'')+'</span></div><div style="margin-top:8px">'+lines+'</div></div>';
  }));
  box.innerHTML=panels.join('');
}
async function showTrace(id){$('tid').textContent=id;const r=await (await fetch('/api/trace/'+encodeURIComponent(id),{headers:{authorization:'Bearer '+KEY}})).json();const sp=r.spans||[];if(!sp.length){$('trace').textContent='no spans yet';return}
const t0=Math.min(...sp.map(x=>x.at-x.ms)),t1=Math.max(...sp.map(x=>x.at)),W=Math.max(1,t1-t0);
$('trace').innerHTML=sp.map(x=>{const l=100*(x.at-x.ms-t0)/W,w=Math.max(.6,100*x.ms/W);const cls=x.outcome==='error'?'error':x.outcome==='hit'?'hit':'';return '<div class="wf"><i class="'+cls+'" style="left:'+l+'%;width:'+w+'%"></i><span>+'+(x.at-x.ms-t0)+'ms '+esc(x.svc)+' '+esc(x.op)+' · '+esc(x.outcome)+' · '+x.ms+'ms '+esc(x.detail||'')+'</span></div>'}).join('')}
async function load(){try{const t0=Date.now();const s=await (await fetch('/api/state',{cache:'no-store',headers:{authorization:'Bearer '+KEY}})).json();s.stateMs=Date.now()-t0;render(s);renderCbs(s);renderSurge(s);renderLock();tickLive()}catch(e){}}
load();setInterval(load,3000);
</script></body></html>`;
