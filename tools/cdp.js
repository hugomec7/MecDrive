// Ferramenta de teste: conversa com a janela do app pela porta de depuração do WebView2.
// Uso: node cdp.js <porta> eval "<js>"   |   node cdp.js <porta> shot <arquivo.png>
let [, , port, cmd, arg] = process.argv;
(async () => {
  const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = pages.find((p) => p.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { pend.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
  if (cmd === 'evalfile') { cmd = 'eval'; arg = require('fs').readFileSync(arg, 'utf8'); }
  if (cmd === 'eval') {
    const r = await send('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
    const res = r.result.exceptionDetails ? { erro: r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text } : r.result.result.value;
    console.log(typeof res === 'string' ? res : JSON.stringify(res, null, 1));
  } else if (cmd === 'shot') {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    require('fs').writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
    console.log('print salvo em', arg);
  }
  ws.close();
})().catch((e) => { console.error('falhou:', e.message || e); process.exit(1); });
