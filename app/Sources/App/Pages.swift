import Foundation

/// Páginas HTML embebidas en el ejecutable (no viven en oficina/).
enum Pages {
    static let claudeInstallURL = "https://docs.claude.com/en/docs/claude-code/setup"

    static let onboarding = #"""
<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Oficina</title>
<style>
:root{--crema:#fff8fc;--cereza:#cf216c;--tinta:#3b1320;--borde:#ecd3e0}
*{box-sizing:border-box}
body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:var(--crema);color:var(--tinta);font:15px/1.5 -apple-system,"Helvetica Neue",sans-serif}
.card{max-width:460px;padding:36px;border:1px solid var(--borde);border-radius:18px;background:#fff;box-shadow:0 8px 30px rgba(207,33,108,.08);text-align:center}
h1{margin:0 0 8px;font-size:22px;color:var(--cereza)}
p{margin:8px 0 18px}
button{font:inherit;font-weight:600;border:0;border-radius:10px;padding:10px 18px;margin:4px;cursor:pointer;background:var(--cereza);color:#fff}
button.sec{background:#fff;color:var(--cereza);border:1px solid var(--cereza)}
.msg{min-height:20px;font-size:13px;color:#9b1f3a}
code{background:#f7e6ef;padding:1px 6px;border-radius:5px;font-size:13px}
</style></head><body><div class="card" id="c"><h1>Oficina</h1><p>Verificando…</p></div>
<script>
const c=document.getElementById('c');
const nativo=a=>window.webkit.messageHandlers.hq.postMessage(a);
function vista(html){c.innerHTML=html}
async function revisar(){
  let e=null;
  try{e=await (await fetch('/api/estado')).json()}catch(x){}
  if(!e){vista('<h1>Oficina</h1><p>No pude hablar con el motor de la oficina.</p><button id="r">Reintentar</button>');r.onclick=revisar;return}
  if(!e.claude){
    vista('<h1>Falta Claude Code</h1><p>Oficina necesita Claude Code instalado en esta Mac para que los agentes respondan.</p><button id="i">Cómo instalar Claude Code</button><button class="sec" id="r">Ya lo instalé</button><div class="msg" id="m"></div>');
    i.onclick=()=>nativo({action:'open',url:'__INSTALL__'});
    r.onclick=async()=>{m.textContent='Buscando…';await revisar();if(document.getElementById('m'))m.textContent='Todavía no encuentro Claude Code.'};
    return}
  if(e.auth===false){
    vista('<h1>Iniciá sesión en Claude</h1><p>Se abrirá la Terminal para que inicies sesión con tu cuenta. Cuando termines, volvé acá.</p><button id="l">Iniciar sesión</button><button class="sec" id="r">Ya inicié sesión</button><div class="msg" id="m"></div>');
    l.onclick=()=>nativo({action:'login'});
    r.onclick=async()=>{m.textContent='Verificando…';await revisar();if(document.getElementById('m'))m.textContent='Todavía no veo la sesión iniciada.'};
    return}
  location.replace('index.html');
}
revisar();
</script></body></html>
"""#.replacingOccurrences(of: "__INSTALL__", with: claudeInstallURL)

    /// Página de verificación de riesgos del contenedor (HQ_SPIKE=1).
    static let spike = #"""
<!doctype html><html><head><meta charset="utf-8"><title>spike</title></head><body><pre id="o">spike…</pre>
<script>
const res={};
const send=o=>window.webkit.messageHandlers.hq.postMessage({action:'spike',result:o});
(async()=>{
  try{
    // 1) POST con body (fetch relativo)
    const small=JSON.stringify({agent:'betty',message:'hola ñandú',session:'x'});
    const r1=await (await fetch('/api/echo',{method:'POST',headers:{'Content-Type':'application/json'},body:small})).json();
    res.postSmall={sent:small.length,received:r1.len,head:r1.head};
    const big=JSON.stringify({message:'x'.repeat(300000)});
    const r2=await (await fetch('/api/echo',{method:'POST',headers:{'Content-Type':'application/json'},body:big})).json();
    res.postBig={sent:big.length,received:r2.len};
    // GET con query
    res.getQuery=await (await fetch('/api/historial?agent=betty&session=abc')).json();
    // 2) XHR sincrono
    try{const x=new XMLHttpRequest();x.open('GET','lego_man.json',false);x.send();const j=JSON.parse(x.responseText);res.syncXHR={status:x.status,bytes:x.responseText.length,keys:Object.keys(j).slice(0,3)}}catch(e){res.syncXHR={error:String(e)}}
    // 3) localStorage
    try{const n=(parseInt(localStorage.getItem('spike-n')||'0')||0)+1;localStorage.setItem('spike-n',String(n));res.localStorage={runs:n}}catch(e){res.localStorage={error:String(e)}}
  }catch(e){res.error=String(e)}
  document.getElementById('o').textContent=JSON.stringify(res,null,1);
  send(res);
})();
</script></body></html>
"""#
}
