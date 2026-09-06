const GOOGLE_CLIENT_ID = '103750685933630009308';
const DEFAULT_API_KEY = '***REDACTED***';

function generateApiKey(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const seg = (n: number) => Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  return `cfat_${seg(8)}${seg(4)}${seg(4)}${seg(4)}${seg(12)}`;
}

const HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CY API Cabinet</title>
<style>
:root {
  --cy-color: #ffffff;
  --cy-accent: #e0e0e0;
  --cy-glow: rgba(255,255,255,0.2);
  --cy-accent-glow: rgba(224,224,224,0.15);
  --bg: #050505;
  --surface: #0a0a0a;
  --border: rgba(255,255,255,0.08);
  --text-primary: #ffffff;
  --text-secondary: rgba(255,255,255,0.5);
}
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { background: var(--bg); color: var(--text-primary); font-family: -apple-system, BlinkMacSystemFont, sans-serif; height: 100%; }
body { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; overflow: hidden; }
.cabinet { max-width: 520px; width: 100%; }
.cabinet-logo { font-size: 36px; font-weight: 800; color: var(--cy-color); letter-spacing: 10px; font-family: monospace; text-shadow: 0 0 24px var(--cy-glow), 0 0 48px var(--cy-glow); margin-bottom: 4px; }
.cabinet-title { font-size: 14px; color: var(--cy-accent); letter-spacing: 4px; text-transform: uppercase; font-family: monospace; margin-bottom: 28px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; margin-bottom: 16px; box-shadow: 0 0 30px var(--cy-glow); }
.card h3 { font-size: 11px; color: var(--text-secondary); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 12px; font-family: monospace; }
.key-display { width: 100%; padding: 12px 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 8px; color: var(--text-primary); font-family: monospace; font-size: 13px; margin-bottom: 12px; outline: none; word-break: break-all; }
.key-display:focus { border-color: var(--cy-color); box-shadow: 0 0 12px var(--cy-glow); }
.btn { width: 100%; padding: 12px; background: var(--cy-color); color: #050505; border: none; border-radius: 8px; font-weight: 700; font-size: 13px; letter-spacing: 2px; cursor: pointer; font-family: monospace; text-transform: uppercase; transition: all 0.2s; }
.btn:hover { box-shadow: 0 0 20px var(--cy-glow); transform: translateY(-2px); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-secondary { background: transparent; border: 1px solid var(--cy-color); color: var(--cy-color); margin-top: 8px; }
.btn-secondary:hover { background: rgba(255,255,255,0.1); }
.google-btn { width: 100%; padding: 12px; background: #fff; color: #050505; border: none; border-radius: 8px; font-weight: 600; font-size: 13px; cursor: pointer; font-family: sans-serif; transition: all 0.2s; display: flex; align-items: center; justify-content: center; gap: 8px; }
.google-btn:hover { box-shadow: 0 0 20px rgba(255,255,255,0.2); }
.status { margin-top: 12px; font-size: 12px; font-family: monospace; color: var(--text-secondary); min-height: 16px; }
.status.error { color: #ff4444; }
.status.success { color: #00ff88; }
.user-info { font-size: 13px; color: var(--text-primary); margin-bottom: 16px; font-family: monospace; }
.user-info span { color: var(--cy-accent); }
.hidden { display: none !important; }
</style>
</head>
<body>
<div class="cabinet">
  <div class="cabinet-logo">CY</div>
  <div class="cabinet-title">API Cabinet</div>

   <div id="login-section" class="card">
     <h3>Account</h3>
     <input type="email" id="email" class="key-display" placeholder="you@email.com" value="VladyslavChaplygin@gmail.com" style="margin-bottom:12px;">
     <button class="google-btn" id="get-key-btn">ПОЛУЧИТЬ КЛЮЧ</button>
     <div class="status" id="status"></div>
   </div>

  <div id="key-section" class="card hidden">
    <h3>API Key</h3>
    <div class="user-info">Account: <span id="user-email"></span></div>
    <input type="text" class="key-display" id="api-key" readonly value="">
    <div class="status" id="key-status" style="color: #00ff88;">Connected! Returning to CY...</div>
  </div>
</div>

<script>
const API_BASE = location.origin;
let currentUser = null;

async function api(path, opts = {}) {
  const res = await fetch(API_BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: 'Error' } }));
    throw new Error(err.error?.message || 'Request failed');
  }
  return res.json();
}

function showStatus(el, msg, type = '') {
  const e = typeof el === 'string' ? document.getElementById(el) : el;
  if (!e) return;
  e.textContent = msg;
  e.className = 'status' + (type ? ' ' + type : '');
}

// Send API key back to extension and redirect
function sendApiKeyToExtension(apiKey) {
  // Use postMessage to send API key back to parent frame (extension)
  if (window.parent && window.parent !== window) {
    window.parent.postMessage(JSON.stringify({
      type: 'cy-api-key-ready',
      apiKey: apiKey,
      redirect: true
    }), '*');
  }
  // Auto-redirect after 2 seconds
  setTimeout(() => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage(JSON.stringify({ type: 'cy-api-key-redirect' }), '*');
    }
  }, 2000);
}

async function getKey() {
  const email = (document.getElementById('email').value || '').trim().toLowerCase();
  if (!email) {
    showStatus('status', 'Введите email', 'error');
    return;
  }
  showStatus('status', 'Получение ключа...');
  try {
    const data = await api('/api/auth/key', {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    currentUser = data.user;
    document.getElementById('user-email').textContent = currentUser.email;
    document.getElementById('api-key').value = currentUser.apiKey;
    document.getElementById('login-section').classList.add('hidden');
    document.getElementById('key-section').classList.remove('hidden');
    showStatus('key-status', 'Connected! Returning to CY...', 'success');
    sendApiKeyToExtension(currentUser.apiKey);
  } catch (e) {
    showStatus('status', e.message, 'error');
  }
}

document.getElementById('get-key-btn')?.addEventListener('click', getKey);
</script>
</body>
</html>`;

export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/api-keys')) {
      return new Response(HTML, {
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders, 'Cache-Control': 'no-store' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ ok: true, provider: 'SYMBIOTYC', model: 'cy/i1a' }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/google') {
      try {
        const body = await request.json() as { id_token?: string };
        if (!body.id_token) {
          return new Response(JSON.stringify({ error: { message: 'id_token required' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const tokenRes = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(body.id_token));
        if (!tokenRes.ok) {
          return new Response(JSON.stringify({ error: { message: 'Invalid Google token' } }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const tokenInfo = await tokenRes.json() as Record<string, any>;
        if (tokenInfo.aud !== GOOGLE_CLIENT_ID) {
          return new Response(JSON.stringify({ error: { message: 'Token audience mismatch' } }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const email = (tokenInfo.email || '').toLowerCase();
        if (!email) {
          return new Response(JSON.stringify({ error: { message: 'No email in token' } }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const userKey = email;
        const existing = await env.PLATFORM_DB.prepare(
          'SELECT id, email, api_key FROM users WHERE email = ?'
        ).bind(userKey).first();
        let apiKey = existing?.api_key;
        if (!apiKey) {
          apiKey = generateApiKey();
          if (existing) {
            await env.PLATFORM_DB.prepare(
              'UPDATE users SET api_key = ?, updated_at = datetime(\'now\') WHERE email = ?'
            ).bind(apiKey, userKey).run();
          } else {
            await env.PLATFORM_DB.prepare(
              'INSERT INTO users (id, email, name, api_key, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))'
            ).bind(crypto.randomUUID(), userKey, tokenInfo.name || email, apiKey, 'symbiotyc', 'cy/i1a').run();
          }
        }

        return new Response(JSON.stringify({
          user: { email, name: tokenInfo.name || email, apiKey },
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Auth failed' } }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/key') {
      try {
        const body = await request.json() as { email?: string };
        const email = (body.email || '').toLowerCase();
        if (!email) {
          return new Response(JSON.stringify({ error: { message: 'email required' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const userKey = email;
        const existing = await env.PLATFORM_DB.prepare(
          'SELECT id, email, api_key FROM users WHERE email = ?'
        ).bind(userKey).first();
        let apiKey = existing?.api_key;
        if (!apiKey) {
          apiKey = generateApiKey();
          if (existing) {
            await env.PLATFORM_DB.prepare(
              'UPDATE users SET api_key = ?, updated_at = datetime(\'now\') WHERE email = ?'
            ).bind(apiKey, userKey).run();
          } else {
            await env.PLATFORM_DB.prepare(
              'INSERT INTO users (id, email, name, api_key, provider, model, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime(\'now\'))'
            ).bind(crypto.randomUUID(), userKey, email, apiKey, 'symbiotyc', 'cy/i1a').run();
          }
        }

        return new Response(JSON.stringify({
          user: { email, name: email, apiKey },
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Auth failed' } }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/keys/regenerate') {
      try {
        const body = await request.json() as { email?: string };
        if (!body.email) {
          return new Response(JSON.stringify({ error: { message: 'email required' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const userKey = body.email;
        const existing = await env.PLATFORM_DB.prepare(
          'SELECT id, email, api_key FROM users WHERE email = ?'
        ).bind(userKey).first();
        if (!existing) {
          return new Response(JSON.stringify({ error: { message: 'User not found' } }), {
            status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const newKey = generateApiKey();
        await env.PLATFORM_DB.prepare(
          'UPDATE users SET api_key = ?, updated_at = datetime(\'now\') WHERE email = ?'
        ).bind(newKey, existing.email).run();
        return new Response(JSON.stringify({ user: { email: existing.email, apiKey: newKey } }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Failed' } }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    return new Response('CY API Cabinet', { status: 404, headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
  },
};
