const http = require('http');

const html = `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CY API PLATFORM</title>
<style>
:root {
  --cy-color: #00ff88;
  --cy-accent: #00d4ff;
  --cy-glow: rgba(0,255,136,0.3);
  --cy-accent-glow: rgba(0,212,255,0.2);
  --bg: #050505;
  --surface: #0a0a0a;
  --border: rgba(255,255,255,0.08);
  --text-primary: #ffffff;
  --text-secondary: rgba(255,255,255,0.5);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: var(--bg); color: var(--text-primary); font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
body { min-height: 100vh; display: flex; align-items: center; justify-content: center; }
.platform-container { max-width: 420px; width: 90%; text-align: center; }
.platform-logo { font-size: 48px; font-weight: 800; color: var(--cy-color); letter-spacing: 12px; font-family: monospace; text-shadow: 0 0 24px var(--cy-glow), 0 0 48px var(--cy-glow); margin-bottom: 8px; }
.platform-title { font-size: 20px; color: var(--cy-accent); letter-spacing: 4px; text-transform: uppercase; font-family: monospace; margin-bottom: 32px; }
.platform-form { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 32px; box-shadow: 0 0 30px var(--cy-glow); }
.platform-form input { width: 100%; padding: 12px 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-family: monospace; font-size: 13px; margin-bottom: 16px; outline: none; transition: border-color 0.2s; }
.platform-form input:focus { border-color: var(--cy-color); box-shadow: 0 0 12px var(--cy-glow); }
.platform-form button { width: 100%; padding: 12px; background: var(--cy-color); color: #050505; border: none; border-radius: 8px; font-weight: 700; font-size: 13px; letter-spacing: 2px; cursor: pointer; transition: all 0.2s; font-family: monospace; text-transform: uppercase; }
.platform-form button:hover { box-shadow: 0 0 20px var(--cy-glow); transform: translateY(-2px); }
.platform-form button:disabled { opacity: 0.5; cursor: not-allowed; }
.platform-status { margin-top: 16px; font-size: 12px; font-family: monospace; color: var(--text-secondary); min-height: 16px; }
.platform-status.error { color: var(--cy-accent); }
.platform-status.success { color: var(--cy-color); }
</style>
</head>
<body>
<div class="platform-container">
  <div class="platform-logo">CY</div>
  <div class="platform-title">API PLATFORM</div>
  <div class="platform-form">
    <input type="text" id="apiKey" placeholder="cfat_..." value="***REDACTED***">
    <button id="connectBtn" onclick="connect()">ПОДКЛЮЧИТЬ</button>
    <div class="platform-status" id="status"></div>
  </div>
</div>
<script>
async function connect() {
  const key = document.getElementById('apiKey').value.trim();
  const btn = document.getElementById('connectBtn');
  const status = document.getElementById('status');
  if (!key) { status.textContent = 'Введите API ключ'; status.className = 'platform-status error'; return; }
  if (!key.startsWith('cfat_')) { status.textContent = 'Ключ должен начинаться с cfat_'; status.className = 'platform-status error'; return; }
  btn.disabled = true; btn.textContent = 'ПОДКЛЮЧЕНИЕ...'; status.textContent = 'Проверка ключа...'; status.className = 'platform-status';
  try {
    const resp = await fetch('https://cy.symbiotyc.workers.dev/v1/chat/completions', {
      method: 'POST', mode: 'cors',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'cy/i1a', messages: [{role:'user',content:'ping'}], stream: false })
    });
    if (resp.ok) {
      const data = await resp.json();
      status.textContent = 'Ключ подтвержден: ' + (data.model || 'cy/i1a');
      status.className = 'platform-status success';
      navigator.clipboard.writeText(key);
      btn.textContent = 'Готово! Ключ скопирован.';
      setTimeout(() => { btn.textContent = 'ПОДКЛЮЧИТЬ'; btn.disabled = false; }, 1500);
    } else {
      const err = await resp.text();
      status.textContent = 'Ошибка: ' + err.slice(0,100);
      status.className = 'platform-status error';
      btn.textContent = 'ПОДКЛЮЧИТЬ'; btn.disabled = false;
    }
  } catch(e) {
    status.textContent = 'Нет связи: ' + (e.message || e);
    status.className = 'platform-status error';
    btn.textContent = 'ПОДКЛЮЧИТЬ'; btn.disabled = false;
  }
}
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(html);
});
server.listen(8791, '127.0.0.1', () => {
  console.log('[platform-server] CY API PLATFORM serving on http://127.0.0.1:8791');
});
