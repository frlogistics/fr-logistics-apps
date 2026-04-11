// netlify/functions/ecopack.js
// EcoPack+ backend

const SUPABASE_URL = Netlify.env.get("SUPABASE_URL");
const SUPABASE_KEY = Netlify.env.get("SUPABASE_SERVICE_KEY");
const WA_TOKEN     = Netlify.env.get("WHATSAPP_TOKEN");
const PHONE_ID     = Netlify.env.get("WHATSAPP_PHONE_ID");
const WA_BASE      = `https://graph.facebook.com/v21.0/${PHONE_ID}/messages`;
const HOURS={1:{o:9,c:17},2:{o:9,c:17},3:{o:9,c:17},4:{o:9,c:17},5:{o:9,c:17},6:{o:9,c:13},0:null};
const SB=()=>({"apikey":SUPABASE_KEY,"Authorization":`Bearer ${SUPABASE_KEY}`,"Content-Type":"application/json"});
async function sbSelect(t,q=""){const r=await fetch(`${SUPABASE_URL}/rest/v1/${t}${q}`,{headers:SB()});if(!r.ok)throw new Error(await r.text());return r.json();}
async function sbInsert(t,d){const r=await fetch(`${SUPABASE_URL}/rest/v1/${t}`,{method:"POST",headers:{...SB(),"Prefer":"return=representation"},body:JSON.stringify(d)});if(!r.ok)throw new Error(await r.text());return r.json();}
async function sbPatch(t,f,d){return(await fetch(`${SUPABASE_URL}/rest/v1/${t}?${f}`,{method:"PATCH",headers:{...SB(),"Prefer":"return=minimal"},body:JSON.stringify(d)})).ok;}
function genSlots(ds){const[y,m,d]=ds.split("-").map(Number);const dow=new Date(y,m-1,d).getDay();const h=HOURS[dow];if(!h)return[];const s=[];for(let hr=h.o;hr<h.c;hr++){for(let mn=0;mn<60;mn+=15){if(hr===h.c-1&&mn+15>60)continue;s.push({value:`${String(hr).padStart(2,"0")}:${String(mn).padStart(2,"0")}`,label:`${hr%12||12}:${String(mn).padStart(2,"0")} ${hr<12?"AM":"PM"}`});}}return s;}
function fmt12(t){const[h,m]=t.split(":").map(Number);return`${h%12||12}:${String(m).padStart(2,"0")} ${h<12?"AM":"PM"}`;}
function fmtDate(s){const[y,m,d]=s.split("-").map(Number);return new Date(y,m-1,d).toLocaleDateString("en-US",{weekday:"long",month:"long",day:"numeric",year:"numeric"});}
async function sendPickupWA(to,name,date,time,cnt){const r=await fetch(WA_BASE,{method:"POST",headers:{"Authorization":`Bearer ${WA_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({messaging_product:"whatsapp",to:to.replace(/\D/g,""),type:"template",template:{name:"ecopack_pickup_scheduled",language:{code:"en"},components:[{type:"body",parameters:[{type:"text",text:name},{type:"text",text:fmtDate(date)},{type:"text",text:fmt12(time)},{type:"text",text:String(cnt)}]}]}})});const j=await r.json();if(!r.ok)throw new Error(j.error?.message);return j.messages?.[0]?.id;}
async function sendAlert(to,name,cnt){const tpl=cnt>1?"ecopack_multi_package":"ecopack_package_received";const params=cnt>1?[{type:"text",text:name},{type:"text",text:String(cnt)}]:[{type:"text",text:name}];const r=await fetch(WA_BASE,{method:"POST",headers:{"Authorization":`Bearer ${WA_TOKEN}`,"Content-Type":"application/json"},body:JSON.stringify({messaging_product:"whatsapp",to:to.replace(/\D/g,""),type:"template",template:{name:tpl,language:{code:"en"},components:[{type:"body",parameters:params}]}})});const j=await r.json();if(!r.ok)throw new Error(j.error?.message);return{template:tpl,msgId:j.messages?.[0]?.id};}
const CORS={"Content-Type":"application/json","Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,Authorization"};
const jRes=(d,s=200)=>new Response(JSON.stringify(d),{status:s,headers:CORS});
export default async function handler(req){
  if(req.method==="OPTIONS")return new Response(null,{status:204,headers:CORS});
  const url=new URL(req.url);const action=url.searchParams.get("action");
  if(req.method==="GET"&&action==="slots"){
    const date=url.searchParams.get("date");
    if(!date)return jRes({error:"date required"},400);
    const booked=await sbSelect("ecopack_pickups",`?pickup_date=eq.${date}&status=not.in.(cancelled)&select=pickup_time`);
    const counts={};for(const b of booked)counts[b.pickup_time]=(counts[b.pickup_time]||0)+1;
    const slots=genSlots(date).map(s=>({...s,available:(counts[s.value]||0)<2}));
    const[y,m,d]=date.split("-").map(Number);
    return jRes({date,isOpen:!!HOURS[new Date(y,m-1,d).getDay()],slots});
  }
  if(req.method==="GET"&&action==="pickups"){
    const st=url.searchParams.get("status")||"";
    return jRes(await sbSelect("ecopack_pickups",st?`?status=eq.${st}&order=pickup_date.asc`:`?order=pickup_date.asc&limit=200`));
  }
  if(req.method==="POST"){
    let body;try{body=await req.json();}catch{return jRes({error:"Invalid JSON"},400);}
    const act=body.action||body.status;
    if((act==="book")&&body.client_name&&body.pickup_date&&body.pickup_time){
      const[y,m,d]=body.pickup_date.split("-").map(Number);
      if(!HOURS[new Date(y,m-1,d).getDay()])return jRes({error:"Not a business day"},400);
      const existing=await sbSelect("ecopack_pickups",`?pickup_date=eq.${body.pickup_date}&pickup_time=eq.${body.pickup_time}&status=not.in.(cancelled)&select=id`);
      if(existing.length>=2)return jRes({error:"Slot fully booked. Please select another time."},409);
      const[p]=await sbInsert("ecopack_pickups",{client_name:body.client_name,wa_number:(body.wa_number||"").replace(/\D/g,""),email:body.email||"",pickup_date:body.pickup_date,pickup_time:body.pickup_time,package_count:parseInt(body.package_count)||1,status:"scheduled",notes:body.notes||""});
      let waMsgId=null;
      if(body.wa_number){try{waMsgId=await sendPickupWA(body.wa_number,body.client_name,body.pickup_date,body.pickup_time,body.package_count||1);}catch(e){console.error("[ecopack]",e.message);}}
      return jRes({ok:true,pickup:p,waMsgId});
    }
    if((act==="complete"||act==="completed")&&body.id){
      await sbPatch("ecopack_pickups",`id=eq.${body.id}`,{status:"completed",completed_at:new Date().toISOString()});
      return jRes({ok:true});
    }
    if((act==="confirm"||act==="confirmed")&&body.id){
      await sbPatch("ecopack_pickups",`id=eq.${body.id}`,{status:"confirmed"});
      return jRes({ok:true});
    }
    if((act==="cancel"||act==="cancelled")&&body.id){
      await sbPatch("ecopack_pickups",`id=eq.${body.id}`,{status:"cancelled"});
      return jRes({ok:true});
    }
    if(act==="notify"){
      const{wa_number,client_name,package_count}=body;
      if(!wa_number||!client_name)return jRes({error:"wa_number and client_name required"},400);
      return jRes({ok:true,...await sendAlert(wa_number,client_name,package_count||1)});
    }
    return jRes({error:"Unknown action"},400);
  }
  return jRes({error:"Method not allowed"},405);
}
export const config={path:"/.netlify/functions/ecopack"};
