// Teste: chama o rc do rclone pelo app. Uso: node rc.js <porta-cdp> <metodo> '<json>'
const { execFileSync } = require('child_process');
const [, , port, method, params = '{}'] = process.argv;
const js = `window.__TAURI__.core.invoke('rc',{method:${JSON.stringify(method)},params:${params},timeoutSecs:15}).then(r=>JSON.stringify(r,null,1)).catch(e=>'ERR '+e)`;
process.stdout.write(execFileSync('node', [__dirname + '/cdp.js', port, 'eval', js]));
