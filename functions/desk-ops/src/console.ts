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
.wf{position:relative;height:22px;margin:3px 0;font:12px var(--mono)}.wf i{position:absolute;top:3px;height:16px;border-radius:2px;background:var(--blue);opacity:.85}
.wf i.error{background:var(--red)}.wf i.hit{background:var(--green)}.wf span{position:absolute;left:0;top:2px;white-space:nowrap;color:var(--ink);text-shadow:0 0 4px #000}
.spark{display:flex;gap:2px;align-items:flex-end;height:20px}.spark i{width:5px;background:var(--green);border-radius:1px}.spark i.bad{background:var(--red)}
#toast{position:fixed;bottom:16px;right:16px;background:#1d242e;border:1px solid var(--amber);padding:10px 14px;border-radius:4px;font:12px var(--mono);display:none}
@media (max-width:900px){.board,.side{grid-column:span 12}main{padding:12px}header{padding:12px}}
</style></head><body>
<header><h1>Nimbus Air · Disruption Desk</h1><span id="mode" class="pill">—</span><span id="queue" class="pill">—</span><span id="health" class="pill">canary —</span><span id="scn" class="mut"></span></header>
<main>
<section class="wide" style="display:flex;flex-wrap:wrap;gap:16px;align-items:center;justify-content:space-between">
<div><h2 style="margin:0 0 6px">Talk to the desk</h2><div class="mut">Call from this browser (allow the microphone). Phone: +1 743 888 2787 (trial account: only the verified number can dial in).
<br>Web calls are treated as the demo passenger, Jun (booking K7Q2ZX), while <b>web calls as demo caller</b> is on; turn it off to verify with a booking from the README.</div></div>
<telnyx-ai-agent agent-id="assistant-dbc59018-c2bb-437f-86bd-1030a9c5271b"></telnyx-ai-agent>
</section>
<div class="kpis" id="kpis"></div>
<section class="board"><h2>Departures · Singapore → Hong Kong</h2><table><thead><tr><th>Flight</th><th>Date</th><th>Dep</th><th>Status</th><th>Seats left</th><th>Held</th><th>Waitlist</th><th></th><th></th></tr></thead><tbody id="flights"></tbody></table></section>
<section class="side"><h2>Controls</h2>
<div class="controls"><input id="key" type="password" placeholder="admin token (stored in this browser)"></div>
<div class="controls"><button onclick="act('/api/scenario',{id:'normal'})">Normal day</button><button class="danger" onclick="act('/api/scenario',{id:'typhoon'})">Typhoon hits HKG</button><button onclick="act('/api/relief',{})">+ Relief flight NB870</button></div>
<div class="controls"><button onclick="flag('disruption_mode')">Toggle disruption flag</button><button onclick="flag('human_queue')">Toggle human queue</button><button onclick="flag('web_calls_as_demo_caller')">Toggle web calls as demo caller</button>
<select id="ttl" onchange="act('/api/flags',{hold_ttl_secs:Number(this.value)})"><option value="600">hold 10 min</option><option value="120">hold 2 min</option><option value="45">hold 45 s</option></select></div>
<div class="controls"><button onclick="act('/api/canary',{run:true})">Start canary</button><button onclick="act('/api/canary',{run:false})">Stop canary</button><button onclick="act('/api/metrics/reset',{})">Reset counters</button></div>
<h2 style="margin-top:16px">Canary · last 30 minutes</h2><div class="spark" id="spark"></div><div class="mut" id="canarytxt" style="font:12px var(--mono);margin-top:6px"></div>
<h2 style="margin-top:16px">Latency p50 / p95 (15 min)</h2><table><tbody id="lat"></tbody></table></section>
<section class="board"><h2>Recent calls</h2><table><thead><tr><th>Trace</th><th>Started</th><th>Caller</th><th>Booking</th><th>Last step</th><th>Outcome</th></tr></thead><tbody id="calls"></tbody></table></section>
<section class="side"><h2>Passengers</h2><table><thead><tr><th>Booking</th><th>Pax</th><th>Case</th><th>Detail</th></tr></thead><tbody id="trips"></tbody></table>
<h2 style="margin-top:16px">Human callback queue</h2><table><tbody id="cbs"></tbody></table></section>
<section class="wide"><h2>Trace <span id="tid" class="mut"></span></h2><div id="trace" class="mut">Click a trace id to see one call's path: assistant → webhook → KV / actor → MCP → reservation system.</div></section>
</main><div id="toast"></div>
<script async src="https://unpkg.com/@telnyx/ai-agent-widget@0.36.0"></script>
<script>
const $=id=>document.getElementById(id);const keyEl=$('key');try{keyEl.value=localStorage.getItem('desk-key')||''}catch(e){}
keyEl.onchange=()=>{try{localStorage.setItem('desk-key',keyEl.value)}catch(e){}};
let S=null;const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const ago=t=>{const s=Math.round((Date.now()-t)/1000);return s<60?s+'s ago':Math.round(s/60)+'m ago'};
function toast(m){const t=$('toast');t.textContent=m;t.style.display='block';clearTimeout(t._h);t._h=setTimeout(()=>t.style.display='none',3500)}
async function act(path,body){const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+keyEl.value},body:JSON.stringify(body)});const j=await r.json();toast(r.ok?'done: '+path:'error: '+(j.error||r.status));load()}
function flag(name){const cur=S?.flags?.[name];const next=name==='human_queue'?(cur==='full'?'open':'full'):(cur==='on'?'off':'on');act('/api/flags',{[name]:next})}
function sum(c,pred){return Object.entries(c).filter(([k])=>pred(k)).reduce((n,[,v])=>n+v,0)}
function render(s){S=s;const f=s.flags;
$('mode').textContent='disruption '+f.disruption_mode;$('mode').className='pill '+(f.disruption_mode==='on'?'on':'');
$('queue').textContent='human queue '+f.human_queue;$('queue').className='pill '+(f.human_queue==='full'?'warn':'');
$('scn').textContent=(s.scenario?('scenario: '+s.scenario.id+' · base '+s.scenario.baseDate+' · hold '+f.hold_ttl_secs+'s'):'no scenario loaded')+' · web calls as demo caller: '+f.web_calls_as_demo_caller;
const runs=s.canary.runs||[];const last=runs[0];const fresh=last&&Date.now()-last.at<90000;const good=last&&last.dv.ok&&last.mcpList.ok&&last.mcpTool.ok;
$('health').textContent=!s.canary.running?'canary off':(fresh&&good?'healthy · '+ago(last.at):'UNHEALTHY');$('health').className='pill '+(!s.canary.running?'':(fresh&&good?'ok':'on'));
$('spark').innerHTML=runs.slice().reverse().map(r=>{const ok=r.dv.ok&&r.mcpList.ok&&r.mcpTool.ok;const h=Math.min(20,4+Math.max(r.dv.ms,r.mcpTool.ms)/150);return '<i class="'+(ok?'':'bad')+'" style="height:'+h+'px" title="'+new Date(r.at).toLocaleTimeString()+' dv '+r.dv.ms+'ms tool '+r.mcpTool.ms+'ms"></i>'}).join('');
$('canarytxt').textContent=last?('last probe '+ago(last.at)+' · webhook '+last.dv.ms+'ms · tools/list '+last.mcpList.ms+'ms · tool call '+last.mcpTool.ms+'ms'+(good?'':' · '+([last.dv,last.mcpList,last.mcpTool].find(p=>!p.ok)||{}).detail)):'no probes yet';
const c=s.metrics.counts;const calls=sum(c,k=>k.startsWith('dv:webhook:'));
const k=[['Calls (15 min)',calls],['Rebooked',sum(c,k=>k==='mcp:tool:confirm_rebooking:ok')],['Refunded',sum(c,k=>k==='mcp:tool:request_refund:ok')],['Waitlisted',sum(c,k=>k==='mcp:tool:join_waitlist:ok')],
['Seat races lost',sum(c,k=>k==='mcp:tool:hold_seats:declined')],['Tool errors (1 min)',s.metrics.errorsLastMinute],['Seats left (HKG)',s.flights.filter(x=>x.status!=='cancelled').reduce((n,x)=>n+x.seatsLeft,0)]];
$('kpis').innerHTML=k.map(([l,v])=>'<div class="kpi"><b'+(l.startsWith('Tool errors')&&v>0?' style="color:var(--red)"':'')+'>'+v+'</b><span>'+l+'</span></div>').join('');
$('flights').innerHTML=s.flights.map(x=>{const pct=x.capacity?Math.round(100*(x.capacity-x.seatsLeft)/x.capacity):0;return '<tr><td>'+x.number+'</td><td>'+x.date.slice(5)+'</td><td>'+x.dep+'</td><td class="'+x.status+'">'+x.status.toUpperCase()+'</td><td>'+x.seatsLeft+'</td><td>'+x.held+'</td><td>'+x.waitlist+'</td><td><div class="bar"><i style="width:'+pct+'%"></i></div></td><td>'+(x.status!=='cancelled'?'<a title="simulate another passenger freeing a seat" onclick="act(\\'/api/release\\',{flightId:\\''+x.id+'\\',seats:1})">free 1</a>':'')+'</td></tr>'}).join('');
$('lat').innerHTML=Object.entries(s.metrics.latency).sort().map(([k,v])=>'<tr><td>'+esc(k)+'</td><td>'+v.p50+' / '+v.p95+' ms</td><td class="mut">n='+v.n+'</td></tr>').join('')||'<tr><td class="mut">no traffic yet</td></tr>';
$('calls').innerHTML=s.metrics.calls.map(r=>'<tr><td><a onclick="showTrace(\\''+r.trace+'\\')">'+r.trace+'</a></td><td>'+ago(r.at)+'</td><td>'+esc(r.caller||'web')+'</td><td>'+esc(r.booking||'—')+'</td><td>'+esc(r.last)+'</td><td>'+esc(r.outcome)+'</td></tr>').join('')||'<tr><td class="mut" colspan=6>no calls yet</td></tr>';
$('trips').innerHTML=s.trips.map(t=>{const d=t.rebookedTo?t.rebookedTo.flightId+' · '+t.rebookedTo.confirmation:t.hold&&t.hold.expiresAt>Date.now()?'holding '+t.hold.flightId+' · '+Math.round((t.hold.expiresAt-Date.now())/1000)+'s':t.refund?t.refund.reference:t.waitlist?'waitlist '+t.waitlist.flightId+(t.callback?' · callback '+(t.callback.placedAt?'placed '+esc(t.callback.result):'due'):''):'';return '<tr><td>'+t.code+'</td><td>'+t.pax+'</td><td>'+t.status+'</td><td class="mut">'+esc(d)+'</td></tr>'}).join('');}
function renderCbs(s){$('cbs').innerHTML=(s.callbacks||[]).map(c=>'<tr><td>'+ago(c.at)+'</td><td>'+esc(c.booking||c.caller||'unknown')+'</td><td class="mut">'+esc(c.reason)+'</td><td><a onclick="showTrace(\\''+c.trace+'\\')">trace</a></td></tr>').join('')||'<tr><td class="mut">empty</td></tr>'}
async function showTrace(id){$('tid').textContent=id;const r=await (await fetch('/api/trace/'+id)).json();const sp=r.spans||[];if(!sp.length){$('trace').textContent='no spans yet';return}
const t0=Math.min(...sp.map(x=>x.at-x.ms)),t1=Math.max(...sp.map(x=>x.at)),W=Math.max(1,t1-t0);
$('trace').innerHTML=sp.map(x=>{const l=100*(x.at-x.ms-t0)/W,w=Math.max(.6,100*x.ms/W);const cls=x.outcome==='error'?'error':x.outcome==='hit'?'hit':'';return '<div class="wf"><i class="'+cls+'" style="left:'+l+'%;width:'+w+'%"></i><span>+'+(x.at-x.ms-t0)+'ms '+esc(x.svc)+' '+esc(x.op)+' · '+esc(x.outcome)+' · '+x.ms+'ms '+esc(x.detail||'')+'</span></div>'}).join('')}
async function load(){try{const s=await (await fetch('/api/state',{cache:'no-store'})).json();render(s);renderCbs(s)}catch(e){}}
load();setInterval(load,3000);
</script></body></html>`;
