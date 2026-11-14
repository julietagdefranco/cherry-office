// `claude` falso para la suite de paridad (port de fixtures/claude-fake.sh, que a su vez es el script de
// app/Tests/BackendTests/TestSupport.swift). En Node para que corra igual en macOS, Linux y Windows.
// El sandbox lo copia a `bin/claude` con un shebang al node actual (macOS/Linux: lo puede lanzar Swift) y a
// `bin/claude.cjs` (Windows: el runner TS lo lanza con node).
//
// Responde según una palabra clave del mensaje (último argumento, o la entrada estándar si no hay `--`): ver la
// documentación de `Sandbox` en test/support/sandbox.ts y en TestSupport.swift. Registra en `args.log` los argumentos
// de cada llamada (si el mensaje vino por stdin, se registra como `-- <mensaje>` al final, igual que por argumento),
// en `cwd.log` la carpeta de trabajo y en `events.log` el orden S/E por agente.
'use strict'
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn } = require('node:child_process')

const D = path.dirname(fs.realpathSync(process.argv[1]))
const p = (f) => path.join(D, f)
const args = process.argv.slice(2)
const dormirSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const dormir = (ms) => new Promise((r) => setTimeout(r, ms))
const salida = (s) => process.stdout.write(s + '\n')

async function main() {
  if (args[0] === 'auth') {
    fs.appendFileSync(p('events.log'), 'AUTH\n')
    if (fs.existsSync(p('noauth'))) { salida('{"loggedIn":false}'); return 1 }
    salida('{"loggedIn":true}')
    return 0
  }
  let agent = ''
  for (let i = 1; i < args.length; i++) if (args[i - 1] === '--agent') agent = args[i]
  // el mensaje: último argumento después de `--`, o la entrada estándar (Windows: la línea de comandos tiene tope)
  let registrados = args
  let msg = args[args.length - 1] ?? ''
  if (!args.includes('--')) {
    // (si un script envoltorio ya leyó la entrada estándar, la deja en globalThis.__hqMensajeStdin)
    msg = globalThis.__hqMensajeStdin ?? fs.readFileSync(0, 'utf8')
    registrados = [...args, '--', msg]
  }
  const rec = registrados.map((a) => a + '\u001f').join('')
  // corridas paralelas no se mezclan
  for (let n = 0; n <= 500; n++) {
    try { fs.mkdirSync(p('args.lock')); break } catch { dormirSync(10) }
  }
  fs.appendFileSync(p('args.log'), rec + '\u001e')
  try { fs.rmdirSync(p('args.lock')) } catch {}
  fs.appendFileSync(p('events.log'), `S ${agent}\n`)
  const fin = () => fs.appendFileSync(p('events.log'), `E ${agent}\n`)
  fs.appendFileSync(p('cwd.log'), process.cwd() + '\n')
  const tiene = (flag) => args.includes(flag)
  const m = msg.normalize('NFC')

  let kind = ''
  if (agent === '') {
    if (m.includes('ador de equipos')) kind = 'borrador'
    else if (m.includes('secretario de actas')) kind = 'acta'
    else if (m.includes('Sos el bibliotecario')) kind = 'ficha'
    else if (m.includes('imagen que est')) kind = 'imagen'
    else if (m.includes('en 3 a 6 palabras')) kind = 'resumen'
  } else {
    if (m.includes('en una reuni')) kind = 'turno'
    else if (m.includes('documento a la biblioteca')) kind = 'lectura'
    else if (m.includes('consulta de un colega')) kind = 'consulta'
  }
  let modo = ''
  if (agent !== '' && fs.existsSync(p(`modo.${agent}`))) modo = fs.readFileSync(p(`modo.${agent}`), 'utf8')
  else if (kind !== '' && fs.existsSync(p(`modo.${kind}`))) modo = fs.readFileSync(p(`modo.${kind}`), 'utf8')

  const lento = async () => {
    const h = spawn(process.execPath, ['-e', 'setTimeout(()=>{},300000)'], { stdio: 'ignore' })
    fs.writeFileSync(p('child.pid'), String(h.pid) + '\n')
    await new Promise((r) => h.once('exit', r))
    fin()
    return 0
  }
  switch (modo) {
    case 'lento': return lento()
    case 'error': salida('{"type":"result","result":"fallo raro","is_error":true}'); fin(); return 0
    case 'vacio': salida('{"type":"result","result":"","is_error":false}'); fin(); return 0
    case 'nojson': salida('esto no es json'); fin(); return 0
    case 'puerta': for (let n = 0; !fs.existsSync(p('go')) && n < 300; n++) await dormir(50); break
  }
  if (m.includes('LENTO')) return lento()
  if (m.includes('DORMIR')) await dormir(1000)
  if (m.includes('USADA') && tiene('--session-id')) {
    salida('{"type":"result","result":"Error: Session ID is already in use","is_error":true}'); fin(); return 1
  }
  if (m.includes('NOCONV') && tiene('--resume')) {
    salida('{"type":"result","result":"No conversation found with session ID","is_error":true}'); fin(); return 1
  }
  if (m.includes('NOTFOUND') && tiene('--resume')) {
    salida('{"type":"result","result":"Error: session not found","is_error":true}'); fin(); return 1
  }
  if (m.includes('LOGINERR')) { salida('{"type":"result","result":"Please run /login","is_error":true}'); fin(); return 1 }
  if (m.includes('NOJSON')) { salida('esto no es json'); fin(); return 0 }
  if (m.includes('SALE3')) { process.stderr.write('boom\n'); fin(); return 3 }
  if (m.includes('ISERR')) { salida('{"type":"result","result":"fallo raro","is_error":true}'); fin(); return 0 }
  if (m.includes('VACIO')) { salida('{"type":"result","result":"","is_error":false}'); fin(); return 0 }

  if (kind !== '') {
    const propia = p(`resp.${kind}.${agent}.json`)
    if (agent !== '' && fs.existsSync(propia)) { process.stdout.write(fs.readFileSync(propia)); fin(); return 0 }
    if (fs.existsSync(p(`resp.${kind}.json`))) { process.stdout.write(fs.readFileSync(p(`resp.${kind}.json`))); fin(); return 0 }
    switch (kind) {
      case 'borrador': salida(String.raw`{"type":"result","result":"Acá va el borrador:\n` + '```' + String.raw`json\n{\"id\":\"valentina\",\"nombre\":\"Valentina\",\"rol\":\"Analista de datos\",\"description\":\"Analista de datos. Usala cuando haga falta medir resultados.\",\"prompt\":\"Sos Valentina, analista de datos.\",\"chips\":[\"¿Cómo vamos?\",\"Armame un informe\",\"¿Qué medimos?\"],\"modelo\":\"sonnet\"}\n` + '```' + '","is_error":false}'); break
      case 'acta': salida(String.raw`{"type":"result","result":"{\"resumen\":\"Se acordó avanzar con el plan.\",\"decisiones\":[\"Lanzar en diciembre\",\"Priorizar los reels\"],\"pendientes\":[{\"quien\":\"Marce\",\"que\":\"Armar el calendario\"}]}","is_error":false}`); break
      case 'ficha': salida(String.raw`{"type":"result","result":"{\"titulo\":\"Ficha de prueba\",\"resumen\":\"Resumen de prueba del documento.\",\"datos_clave\":[\"dato uno\"],\"temas\":[\"pruebas\"],\"util_para\":[\"direccion\"],\"fechas\":[],\"contradicciones\":[]}","is_error":false}`); break
      case 'imagen': salida('{"type":"result","result":"Una imagen de prueba con el texto HOLA MUNDO.","is_error":false}'); break
      case 'resumen': salida('{"type":"result","result":"«Armando el plan de diciembre.»","is_error":false,"total_cost_usd":0.001}'); break
      case 'turno': salida(JSON.stringify({ type: 'result', result: `Opinión de ${agent} sobre el tema.`, is_error: false, total_cost_usd: 0.02 })); break
      case 'lectura':
        fs.mkdirSync('conocimiento/agentes', { recursive: true })
        fs.appendFileSync(path.join('conocimiento/agentes', `${agent}.md`), '- leyó el documento (prueba)\n')
        salida('{"type":"result","result":"listo","is_error":false}')
        break
      case 'consulta': salida(JSON.stringify({ type: 'result', result: `Mi mirada de ${agent} sobre la consulta.`, is_error: false, total_cost_usd: 0.03 })); break
    }
    fin()
    return 0
  }

  const mcp = () => {
    const cfg = args[args.indexOf('--mcp-config') + 1] ?? ''
    const url = (cfg.match(/http:\/\/127[^"]*/) ?? [''])[0]
    const token = process.env.HQ_MCP_TOKEN ?? ''
    fs.appendFileSync(p('token.log'), token + '\n')
    fs.appendFileSync(p('url.log'), url + '\n')
    return { url, token }
  }
  const post = (url, token, body) => new Promise((resolve) => {
    let u
    try { u = new URL(url) } catch { return resolve('') }
    const datos = Buffer.from(body)
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: 'POST', timeout: 20000,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': datos.length } }, (res) => {
      const partes = []
      res.on('data', (c) => partes.push(c))
      res.on('end', () => resolve(Buffer.concat(partes).toString('utf8')))
    })
    req.on('error', () => resolve(''))
    req.on('timeout', () => { req.destroy(); resolve('') })
    req.end(datos)
  })

  if (m.includes('CONSULTAR:')) {
    // llama a `consultar` del servidor MCP con el token del entorno, como haría claude (x4: cuatro veces)
    const colega = m.slice(m.indexOf('CONSULTAR:') + 'CONSULTAR:'.length).split(' ')[0]
    const veces = m.includes('x4') ? 4 : 1
    const { url, token } = mcp()
    for (let i = 1; i <= veces; i++) {
      const body = JSON.stringify({ jsonrpc: '2.0', id: i, method: 'tools/call', params: { name: 'consultar', arguments: { colega, pregunta: 'Como vamos con lo tuyo?' } } })
      fs.appendFileSync(p(`mcp.${agent}.out`), (await post(url, token, body)) + '\n')
    }
    salida('{"type":"result","result":"consulte","is_error":false,"total_cost_usd":0.01}')
    fin()
    return 0
  }
  if (m.includes('CREADOR_LLAMAR')) {
    // hace las llamadas de creador.calls al servidor MCP con el token del entorno, como haría el Creador de verdad
    const { url, token } = mcp()
    let i = 0
    if (fs.existsSync(p('creador.calls'))) {
      for (const linea of fs.readFileSync(p('creador.calls'), 'utf8').split('\n')) {
        if (linea === '') continue
        i++
        const body = `{"jsonrpc":"2.0","id":${i},"method":"tools/call","params":${linea}}`
        fs.appendFileSync(p('creador.out'), (await post(url, token, body)) + '\n')
      }
    }
    salida('{"type":"result","result":"Listo, armé las tarjetas.","is_error":false,"total_cost_usd":0.02}')
    fin()
    return 0
  }
  if (m.includes('ENTREGA:')) {
    // escribe el archivo pedido (relativo a la carpeta de trabajo) y lo informa como un Write de claude
    const rel = m.slice(m.indexOf('ENTREGA:') + 'ENTREGA:'.length).split(' ')[0]
    const destino = path.join(process.cwd(), rel)
    try {
      fs.mkdirSync(path.dirname(destino), { recursive: true })
      fs.writeFileSync(destino, `entregado por ${agent}\n`)
    } catch {} // en Windows un nombre con salto de línea no se puede crear
    // la línea se arma pegando texto, como el script de bash: si la ruta trae un salto de línea o comillas, la línea
    // deja de ser JSON y el backend la ignora (los tests cuentan con eso). Solo se escapan las `\` de Windows.
    const ruta = (process.cwd() + '/' + rel).replace(/\\/g, '\\\\')
    salida(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"${ruta}","content":"x"}}]}}`)
    salida('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Write","input":{"file_path":"/fuera/de/la/oficina.md"}}]}}')
    salida(JSON.stringify({ type: 'result', result: `Listo, dejé ${rel}`, is_error: false, total_cost_usd: 0.03 }))
    fin()
    return 0
  }
  if (m.includes('STREAM')) {
    salida('{"type":"system","subtype":"hook_started","hook_name":"x"}')
    salida(JSON.stringify({ type: 'system', subtype: 'init', session_id: `s-${agent}` }))
    salida('{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""}]}}')
    salida('{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/x/conocimiento/oficina.md"}}]}}')
    if (m.includes('PAUSA')) for (let n = 0; !fs.existsSync(p('go')) && n < 300; n++) await dormir(50)
    salida('{"type":"user","message":{"content":[{"type":"tool_result","content":"secreto"}]}}')
    salida('{"type":"assistant","message":{"content":[{"type":"text","text":"listo"}]}}')
    salida(JSON.stringify({ type: 'result', subtype: 'success', result: `stream ${agent}`, is_error: false, total_cost_usd: 0.25 }))
    fin()
    return 0
  }
  salida(JSON.stringify({ type: 'result', result: `hola ${agent}`, is_error: false, total_cost_usd: 0.01 }))
  fin()
  return 0
}

main().then((rc) => { process.exitCode = rc }, (e) => { process.stderr.write(String(e && e.stack || e) + '\n'); process.exitCode = 99 })
