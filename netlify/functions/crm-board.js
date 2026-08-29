<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>FR-Logistics · Pipeline Scorecard</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,sans-serif;background:#F4F6FB;color:#1A2238;padding:1.4rem;min-height:100vh}
  .wrap{max-width:1560px;margin:0 auto}

  .hdr{display:flex;justify-content:space-between;align-items:flex-end;flex-wrap:wrap;gap:1rem;margin-bottom:1.3rem}
  .hdr .eb{font-size:.66rem;font-weight:800;letter-spacing:.2em;text-transform:uppercase;color:#00B4AA;margin-bottom:.3rem}
  .hdr h1{font-size:1.55rem;font-weight:800;letter-spacing:-.02em;color:#0F1D35}
  .hdr .sub{font-size:.85rem;color:#7B8AA0;margin-top:.2rem}
  .hdrTools{display:flex;align-items:center;gap:.6rem}

  .btn{border:1px solid #E4E9F2;background:#fff;color:#0F1D35;font-family:inherit;font-size:.78rem;font-weight:700;
       padding:.5rem .9rem;border-radius:8px;cursor:pointer;transition:all .12s}
  .btn:hover{border-color:#00B4AA;color:#00B4AA}
  .btn:focus-visible{outline:2px solid #00B4AA;outline-offset:2px}
  .btn.on{background:#0F1D35;color:#fff;border-color:#0F1D35}

  /* KPI strip */
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:.75rem;margin-bottom:1.2rem}
  .kpi{background:#fff;border:1px solid #E4E9F2;border-radius:12px;padding:.95rem 1.05rem;box-shadow:0 2px 8px rgba(20,30,60,.04)}
  .kpi .l{font-size:.66rem;font-weight:800;letter-spacing:.1em;text-transform:uppercase;color:#94A3B8}
  .kpi .v{font-size:1.85rem;font-weight:900;letter-spacing:-.03em;color:#0F1D35;margin-top:.3rem;line-height:1}
  .kpi .f{font-size:.72rem;color:#7B8AA0;margin-top:.35rem}
  .kpi.alert{border-color:#F3B0B0;background:#FFF7F7}
  .kpi.alert .v{color:#C0392B}
  .kpi.warn{border-color:#F4D9A8;background:#FFFCF5}
  .kpi.warn .v{color:#B26B00}
  .kpi.good .v{color:#00867E}

  .card{background:#fff;border:1px solid #E4E9F2;border-radius:12px;box-shadow:0 2px 8px rgba(20,30,60,.04);margin-bottom:1.1rem}
  .ch{padding:.85rem 1.1rem;border-bottom:1px solid #EEF2F7;display:flex;justify-content:space-between;align-items:center;gap:.6rem;flex-wrap:wrap}
  .ch h2{font-size:.82rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#475569}
  .ch .note{font-size:.72rem;color:#94A3B8;font-weight:500;letter-spacing:0;text-transform:none}

  table{width:100%;border-collapse:collapse;font-size:.82rem}
  th{text-align:left;font-size:.64rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;color:#94A3B8;
     padding:.6rem 1.1rem;border-bottom:1px solid #EEF2F7;white-space:nowrap;background:#FBFCFE}
  td{padding:.7rem 1.1rem;border-bottom:1px solid #F4F7FA;vertical-align:top}
  tr:last-child td{border-bottom:none}
  tr.row:hover{background:#F8FAFC}
  .acct{font-weight:700;color:#0F1D35}
  .meta{font-size:.72rem;color:#7B8AA0;margin-top:.15rem}
  .ref{font-family:'Consolas',ui-monospace,monospace;font-size:.72rem;color:#475569}
  .amt{font-family:'Consolas',ui-monospace,monospace;font-weight:700;color:#0F1D35;white-space:nowrap}

  /* signature element: the idle-age bar. Length and colour encode how long
     an item has sat with nobody touching it. */
  .age{display:flex;align-items:center;gap:.45rem;min-width:104px}
  .ageBar{height:6px;border-radius:3px;background:#00B4AA;flex-shrink:0}
  .ageTxt{font-size:.7rem;font-weight:700;color:#7B8AA0;white-space:nowrap}
  .a1{background:#00B4AA}.a2{background:#F0B429}.a3{background:#E8833A}.a4{background:#C0392B}

  .pill{display:inline-block;font-size:.66rem;font-weight:800;letter-spacing:.05em;text-transform:uppercase;
        padding:.2rem .5rem;border-radius:5px;white-space:nowrap}
  .p-draft{background:#EEF2F7;color:#475569}
  .p-sent{background:#E6F7F6;color:#00867E}
  .p-negotiating{background:#FFF4E0;color:#B26B00}
  .p-won{background:#E4F6E8;color:#1E7B3C}
  .p-lost{background:#F6E7E7;color:#A03A2E}
  .p-new{background:#EAF0FB;color:#3A5BA0}
  .p-qualifying{background:#FFF4E0;color:#B26B00}
  .p-sent_to_sales{background:#E6F7F6;color:#00867E}
  .flag{font-size:.66rem;font-weight:800;padding:.2rem .45rem;border-radius:5px;background:#FBE9E7;color:#C0392B;white-space:nowrap}
  .flag.due{background:#FFF4E0;color:#B26B00}

  select,input[type=text],input[type=date]{font-family:inherit;font-size:.76rem;padding:.32rem .45rem;
       border:1px solid #E4E9F2;border-radius:6px;background:#fff;color:#0F1D35;max-width:100%}
  select:focus,input:focus{outline:2px solid #00B4AA;outline-offset:0;border-color:#00B4AA}
  .actWrap{display:flex;flex-direction:column;gap:.3rem;min-width:220px}
  .actWrap input[type=text]{width:100%}
  .actRow{display:flex;gap:.3rem;align-items:center}

  .empty{padding:2.2rem 1.1rem;text-align:center;color:#94A3B8;font-size:.85rem}
  .toast{position:fixed;bottom:1.2rem;right:1.2rem;background:#0F1D35;color:#fff;padding:.7rem 1.1rem;border-radius:9px;
         font-size:.82rem;font-weight:600;box-shadow:0 6px 20px rgba(15,29,53,.25);opacity:0;transform:translateY(8px);
         transition:opacity .2s,transform .2s;pointer-events:none;z-index:50;max-width:min(420px,90vw)}
  .toast.show{opacity:1;transform:translateY(0)}
  .toast.err{background:#C0392B}
  .saving{opacity:.5}
  .ovl{display:none;position:fixed;inset:0;background:rgba(15,29,53,.45);z-index:60;
       align-items:center;justify-content:center;padding:1rem}
  .ovl.show{display:flex}
  .modal{background:#fff;border-radius:14px;width:min(860px,96vw);max-height:90vh;display:flex;
         flex-direction:column;box-shadow:0 18px 50px rgba(15,29,53,.3)}
  .mh{padding:1rem 1.2rem;border-bottom:1px solid #EEF2F7;display:flex;justify-content:space-between;align-items:center;gap:1rem}
  .mh h3{font-size:.95rem;font-weight:800;color:#0F1D35}
  .mb{padding:1.1rem 1.2rem;overflow:auto}
  .mf{padding:.9rem 1.2rem;border-top:1px solid #EEF2F7;display:flex;justify-content:flex-end;align-items:center;gap:.6rem;flex-wrap:wrap}
  .mf .note{margin-right:auto;font-size:.74rem;color:#7B8AA0}
  .warn{background:#FFFCF5;border:1px solid #F4D9A8;border-radius:9px;padding:.7rem .9rem;margin-bottom:.9rem}
  .warn.stop{background:#FFF7F7;border-color:#F3B0B0}
  .warn li{font-size:.78rem;color:#7A5A18;margin-left:1rem;line-height:1.5}
  .warn.stop li{color:#8E2F22}
  .kv{display:grid;grid-template-columns:150px 1fr;gap:.3rem .8rem;font-size:.8rem;margin-bottom:1rem}
  .kv dt{color:#94A3B8;font-weight:700}
  .kv dd{color:#0F1D35}
  .rt{width:100%;border-collapse:collapse;font-size:.78rem}
  .rt th{padding:.4rem .6rem;font-size:.62rem}
  .rt td{padding:.4rem .6rem;border-bottom:1px solid #F4F7FA}
  @media (prefers-reduced-motion:reduce){*{transition:none!important}}
  @media(max-width:820px){ body{padding:.9rem} .hdr{align-items:flex-start} th,td{padding:.55rem .7rem} }
</style>
</head>
<body>
<div class="wrap">

  <div class="hdr">
    <div>
      <div class="eb">FR-Logistics · Commercial</div>
      <h1>Pipeline Scorecard</h1>
      <div class="sub" id="sub">Loading…</div>
    </div>
    <div class="hdrTools">
      <button class="btn on" id="fAll"    onclick="setFilter('all',this)">All</button>
      <button class="btn"    id="fAction" onclick="setFilter('action',this)">Needs action</button>
      <button class="btn"    id="fStale"  onclick="setFilter('stale',this)">Idle 30+ days</button>
      <button class="btn" onclick="load()">Refresh</button>
    </div>
  </div>

  <div class="kpis" id="kpis"></div>

  <div class="card">
    <div class="ch">
      <h2>Quotes</h2>
      <span class="note">Change the status here and it saves to the database immediately.</span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Account</th><th>Reference</th><th>Monthly</th><th>Minimum</th>
          <th>Idle</th><th>Expires</th><th>Status</th>
        </tr></thead>
        <tbody id="qBody"></tbody>
      </table>
    </div>
    <div class="empty" id="qEmpty" style="display:none">No quotes match this filter.</div>
  </div>

  <div class="card">
    <div class="ch">
      <h2>Leads</h2>
      <span class="note">Only real leads. Duplicates, internal numbers and vendors are filtered out.</span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Contact</th><th>Interest</th><th>Source</th>
          <th>Idle</th><th>Next action</th><th>Status</th>
        </tr></thead>
        <tbody id="lBody"></tbody>
      </table>
    </div>
    <div class="empty" id="lEmpty" style="display:none">No leads match this filter.</div>
  </div>

</div>
<div id="convOverlay" class="ovl" onclick="if(event.target===this)closeConvert()">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="convTitle">
    <div class="mh"><h3 id="convTitle">Create client from quote</h3>
      <button class="btn" onclick="closeConvert()" aria-label="Close">Close</button></div>
    <div class="mb" id="convBody">Loading…</div>
    <div class="mf">
      <span class="note" id="convHint"></span>
      <button class="btn" onclick="closeConvert()">Cancel</button>
      <button class="btn on" id="convGo" onclick="doConvert()">Create client</button>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
const API = "/.netlify/functions/crm-board";
const CONVERT_API = "/.netlify/functions/quote-convert";
const QUOTE_STATUSES = ['draft','sent','negotiating','won','lost'];
const LEAD_STATUSES   = ['new','qualifying','sent_to_sales','won','lost'];
let DATA = { quotes:[], leads:[], kpi:{} };
let FILTER = 'all';

const esc = s => String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                  .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const money = n => (n==null||n==='') ? '—'
  : '$'+Number(n).toLocaleString('en-US',{minimumFractionDigits:0,maximumFractionDigits:0});

let toastTimer;
function toast(msg, isErr){
  const t=document.getElementById('toast');
  t.textContent=msg; t.className='toast show'+(isErr?' err':'');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>t.className='toast',3600);
}

/* The idle bar is the spine of this board: how long something has sat
   with nobody touching it. Caps at 60 days so one ancient row does not
   flatten the rest of the scale. */
function ageCell(days){
  if(days==null) return '<span class="ageTxt">—</span>';
  const w   = Math.max(6, Math.min(60, days) / 60 * 64);
  const cls = days>30 ? 'a4' : days>14 ? 'a3' : days>7 ? 'a2' : 'a1';
  const lbl = days===0 ? 'today' : days+'d';
  return `<div class="age"><span class="ageBar ${cls}" style="width:${w}px"></span>`
       + `<span class="ageTxt">${lbl}</span></div>`;
}

function statusSelect(kind, id, current){
  const list = kind==='quote' ? QUOTE_STATUSES : LEAD_STATUSES;
  const fn   = kind==='quote' ? 'saveQuoteStatus' : 'saveLeadStatus';
  const opts = list.map(s=>`<option value="${s}"${s===current?' selected':''}>`
             + s.replace(/_/g,' ')+`</option>`).join('');
  return `<span class="pill p-${esc(current)}">${esc(String(current).replace(/_/g,' '))}</span>`
       + `<br><select style="margin-top:.35rem" onchange="${fn}('${esc(id)}',this)">${opts}</select>`;
}

function renderKPIs(k){
  const cards = [
    ['Open quotes', k.open_quotes, `${k.unsent_quotes} still unsent`, k.unsent_quotes>0?'warn':''],
    ['Value on the table', money(k.value_on_table), 'Monthly, open quotes only', 'good'],
    ['Expiring in 7 days', k.expiring_7d, k.expired_quotes?`${k.expired_quotes} already expired`:'None expired', (k.expiring_7d||k.expired_quotes)?'alert':''],
    ['Leads untouched', k.leads_untouched, `${k.leads_working} being worked`, k.leads_untouched>25?'warn':''],
    ['Overdue actions', k.actions_overdue, `${k.actions_next_7d} due in 7 days`, k.actions_overdue>0?'alert':''],
    ['Idle over 30 days', k.stale_over_30d, 'Quotes and leads, nobody touched', k.stale_over_30d>10?'warn':''],
    ['Won', k.won_quotes, `${k.lost_quotes} lost`, 'good']
  ];
  document.getElementById('kpis').innerHTML = cards.map(([l,v,f,c])=>
    `<div class="kpi ${c}"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div>`
   +`<div class="f">${esc(f)}</div></div>`).join('');
}

function passes(row, kind){
  if(FILTER==='stale')  return (row.days_idle||0) > 30;
  if(FILTER==='action') return kind==='quote'
    ? (row.expired || (row.days_to_expiry!=null && row.days_to_expiry<=7) || row.status==='draft')
    : (row.action_overdue || row.status==='new');
  return true;
}

function renderQuotes(){
  const rows = DATA.quotes
    .filter(q=>['draft','sent','negotiating'].includes(q.status))
    .filter(q=>passes(q,'quote'));
  document.getElementById('qEmpty').style.display = rows.length?'none':'block';
  document.getElementById('qBody').innerHTML = rows.map(q=>{
    let exp = '<span class="ageTxt">—</span>';
    if(q.expired) exp = `<span class="flag">expired ${Math.abs(q.days_to_expiry)}d ago</span>`;
    else if(q.days_to_expiry!=null) exp = q.days_to_expiry<=7
      ? `<span class="flag due">in ${q.days_to_expiry}d</span>`
      : `<span class="ageTxt">${esc(q.valid_until)}</span>`;
    const unsent = q.status==='draft' ? ' <span class="flag due">not sent</span>' : '';
    return `<tr class="row" id="q-${esc(q.quote_id)}">
      <td><div class="acct">${esc(q.client_name)}${unsent}</div>
          <div class="meta">${esc(q.contact_name||q.contact_email||'')}</div></td>
      <td><span class="ref">${esc(q.quote_id)}</span><div class="meta">${esc(q.op_type||'')}</div></td>
      <td class="amt">${money(q.subtotal)}</td>
      <td class="amt">${money(q.min_billing)}</td>
      <td>${ageCell(q.days_idle)}</td>
      <td>${exp}</td>
      <td>${statusSelect('quote', q.quote_id, q.status)}</td>
    </tr>`;
  }).join('');
}

function renderLeads(){
  const rows = DATA.leads.filter(l=>passes(l,'lead'));
  document.getElementById('lEmpty').style.display = rows.length?'none':'block';
  document.getElementById('lBody').innerHTML = rows.map(l=>{
    const name = (l.name||'').length>60 ? (l.name||'').slice(0,60)+'…' : (l.name||l.email||'Unnamed');
    const due  = l.action_overdue ? '<span class="flag">overdue</span>' : '';
    const interest = l.service_detail
      ? (l.service_detail.length>70 ? l.service_detail.slice(0,70)+'…' : l.service_detail)
      : (l.service||'').replace(/_/g,' ');
    return `<tr class="row" id="l-${esc(l.id)}">
      <td><div class="acct">${esc(name)}</div>
          <div class="meta">${esc(l.email||'')}${l.phone?' · '+esc(l.phone):''}</div></td>
      <td><div class="meta" style="margin:0">${esc(interest)}</div>
          ${l.monthly_volume?`<div class="meta">${esc(l.monthly_volume)}</div>`:''}</td>
      <td><div class="meta" style="margin:0">${esc((l.source||'').replace(/_/g,' '))}</div>
          <div class="meta">${esc((l.created_at||'').slice(0,10))}</div></td>
      <td>${ageCell(l.days_idle)}</td>
      <td><div class="actWrap">
            <input type="text" value="${esc(l.next_action||'')}" placeholder="What happens next"
                   onchange="saveLeadAction('${esc(l.id)}',this)">
            <div class="actRow">
              <input type="date" value="${esc(l.next_action_date||'')}"
                     onchange="saveLeadDate('${esc(l.id)}',this)">${due}
            </div>
          </div></td>
      <td>${statusSelect('lead', l.id, l.status)}</td>
    </tr>`;
  }).join('');
}

function render(){ renderKPIs(DATA.kpi); renderQuotes(); renderLeads(); }

function setFilter(f, btn){
  FILTER=f;
  document.querySelectorAll('.hdrTools .btn').forEach(b=>b.classList.remove('on'));
  btn.classList.add('on');
  render();
}

async function load(){
  try{
    const r = await fetch(API+'?action=board');
    const j = await r.json();
    if(!j.ok) throw new Error(j.error||'Could not load the board');
    DATA=j; render();
    document.getElementById('sub').textContent =
      'Live from Supabase · updated '+new Date(j.generated_at)
        .toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  }catch(e){
    document.getElementById('sub').textContent='Could not reach the board. Press Refresh to try again.';
    toast(e.message,true);
  }
}

async function post(body, rowEl){
  if(rowEl) rowEl.classList.add('saving');
  try{
    const r = await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},
                              body:JSON.stringify(body)});
    const j = await r.json();
    if(!j.ok) throw new Error(j.error||'Save failed');
    return j.row;
  } finally { if(rowEl) rowEl.classList.remove('saving'); }
}

async function saveQuoteStatus(quoteId, sel){
  const row=document.getElementById('q-'+quoteId);
  try{
    await post({action:'update_quote',quote_id:quoteId,status:sel.value},row);
    const q=DATA.quotes.find(x=>x.quote_id===quoteId); if(q) q.status=sel.value;
    toast('Quote '+quoteId+' moved to '+sel.value.replace(/_/g,' ')); render();
    if(sel.value==='won') openConvert(quoteId);
  }catch(e){ toast(e.message,true); load(); }
}
async function saveLeadStatus(id, sel){
  const row=document.getElementById('l-'+id);
  try{
    await post({action:'update_lead',id:id,status:sel.value},row);
    const l=DATA.leads.find(x=>x.id===id); if(l) l.status=sel.value;
    toast('Lead moved to '+sel.value.replace(/_/g,' ')); render();
  }catch(e){ toast(e.message,true); load(); }
}
async function saveLeadAction(id, input){
  try{
    await post({action:'update_lead',id:id,next_action:input.value},document.getElementById('l-'+id));
    const l=DATA.leads.find(x=>x.id===id); if(l) l.next_action=input.value;
    toast('Next action saved');
  }catch(e){ toast(e.message,true); }
}
async function saveLeadDate(id, input){
  try{
    await post({action:'update_lead',id:id,next_action_date:input.value||null},
               document.getElementById('l-'+id));
    const l=DATA.leads.find(x=>x.id===id); if(l) l.next_action_date=input.value||null;
    toast('Date saved'); load();
  }catch(e){ toast(e.message,true); }
}

/* ── Create client from a won quote ────────────────────────────────────────
   Always previews first. Nothing is written until "Create client" is pressed. */
let _convQuote=null, _convAllowDup=false;

async function openConvert(quoteId){
  _convQuote=quoteId; _convAllowDup=false;
  document.getElementById('convOverlay').classList.add('show');
  document.getElementById('convBody').innerHTML='Loading preview…';
  document.getElementById('convGo').style.display='none';
  document.getElementById('convHint').textContent='';
  try{
    const r=await fetch(CONVERT_API,{method:'POST',headers:{'Content-Type':'application/json'},
                                    body:JSON.stringify({quote_id:quoteId})});
    const p=await r.json();
    if(!p.ok) throw new Error(p.error||'Preview failed');
    renderConvert(p);
  }catch(e){
    document.getElementById('convBody').innerHTML='<div class="warn stop"><li>'+esc(e.message)+'</li></div>';
  }
}
function closeConvert(){ document.getElementById('convOverlay').classList.remove('show'); _convQuote=null; }

function renderConvert(p){
  const c=p.client;
  const dupes=(p.existing_clients||[]).length;
  let html='';
  if(p.warnings&&p.warnings.length)
    html+='<div class="warn'+(p.blocking?' stop':'')+'"><ul style="list-style:disc">'
        + p.warnings.map(w=>'<li>'+esc(w)+'</li>').join('')+'</ul></div>';
  html+='<dl class="kv">'
     +'<dt>Client code</dt><dd class="ref">'+esc(p.client_code)+'</dd>'
     +'<dt>Company</dt><dd>'+esc(c.company)+'</dd>'
     +'<dt>Contact</dt><dd>'+esc(c.name)+(c.email?' · '+esc(c.email):'')+'</dd>'
     +'<dt>Status</dt><dd>'+esc(c.status)+'</dd>'
     +'<dt>Minimum billing</dt><dd>'+money(c.mmb)+'</dd>'
     +'<dt>Services</dt><dd>'+esc((p.services||[]).join(', ')||'—')+'</dd>'
     +'</dl>';
  html+='<div style="font-size:.68rem;font-weight:800;letter-spacing:.09em;text-transform:uppercase;'
      + 'color:#94A3B8;margin-bottom:.4rem">Rates that become contractual</div>';
  if(!(p.rates||[]).length){
    html+='<div class="meta">No quoted line maps to a rate column.</div>';
  }else{
    html+='<table class="rt"><thead><tr><th>Service</th><th>Code</th><th>Column</th><th>Rate</th></tr></thead><tbody>'
        + p.rates.map(r=>'<tr><td>'+esc(r.service||'')+'</td><td class="ref">'+esc(r.code)+'</td>'
        + '<td class="ref">'+esc(r.column)+(r.billing_gap?' <span class="flag due">not billed yet</span>':'')+'</td>'
        + '<td class="amt">$'+Number(r.rate).toFixed(2)+'</td></tr>').join('')+'</tbody></table>';
  }
  if((p.unmapped||[]).length)
    html+='<div class="meta" style="margin-top:.7rem">Not saved: '
        + p.unmapped.map(u=>esc(u.code)).join(', ')+'</div>';
  document.getElementById('convBody').innerHTML=html;

  const go=document.getElementById('convGo');
  if(p.quote_status!=='won'){
    go.style.display='none';
    document.getElementById('convHint').textContent='Mark the quote won before converting it.';
  }else{
    go.style.display='';
    go.textContent = dupes ? 'Create anyway' : 'Create client';
    _convAllowDup = dupes>0;
    document.getElementById('convHint').textContent = dupes
      ? 'A matching client already exists. Check it before creating a second record.'
      : 'This writes to fr_clients and fr_client_rates.';
  }
}

async function doConvert(){
  const go=document.getElementById('convGo');
  go.disabled=true; go.textContent='Creating…';
  try{
    const r=await fetch(CONVERT_API,{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({quote_id:_convQuote,confirm:true,allow_duplicate:_convAllowDup})});
    const j=await r.json();
    if(!j.ok) throw new Error(j.error||'Could not create the client');
    toast('Client '+j.client_code+' created with '+j.rates_written+' rates');
    closeConvert(); load();
  }catch(e){ toast(e.message,true); }
  finally{ go.disabled=false; go.textContent='Create client'; }
}

load();
setInterval(load, 120000);
</script>
</body>
</html>
