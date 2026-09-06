export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, Stripe-Signature',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const origin = url.origin;

    // --- API Key Creation ---
    if (request.method === 'POST' && url.pathname === '/api/auth/key') {
      try {
        const body = await request.json() as Record<string, any>;
        const email = body.email;
        if (!email || typeof email !== 'string' || !email.includes('@')) {
          return new Response(JSON.stringify({ error: { message: 'Valid email required' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const userKey = email.toLowerCase();
        const existing = await env.PLATFORM_DB.prepare(
          'SELECT api_key FROM users WHERE email = ?'
        ).bind(userKey).first();
        let apiKey = existing?.api_key;
        if (!apiKey) {
          apiKey = 'cfat_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
          await env.PLATFORM_DB.prepare(
            'INSERT INTO users (id, email, api_key, plan, quota_requests, quota_used, quota_reset_at, billing_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
          ).bind(
            'user-' + crypto.randomUUID(),
            userKey,
            apiKey,
            'free',
            1000,
            0,
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            'active'
          ).run();
        }

        return new Response(JSON.stringify({
          user: { email: userKey, name: userKey, apiKey },
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Auth failed' } }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- List Users ---
    if (request.method === 'GET' && url.pathname === '/admin/users') {
      try {
        const result = await env.PLATFORM_DB.prepare(
          'SELECT id, email, plan, quota_requests, quota_used, billing_status, created_at FROM users ORDER BY created_at DESC'
        ).all();
        const users = result.results.map((row: any) => ({
          id: row.id,
          email: row.email,
          apiKey: '***',
          plan: row.plan,
          quotaRequests: row.quota_requests,
          quotaUsed: row.quota_used,
          billingStatus: row.billing_status,
          createdAt: row.created_at,
        }));
        return new Response(JSON.stringify({ users, count: users.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: 'Failed to list users' } }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- Update User Plan ---
    if (request.method === 'POST' && url.pathname.startsWith('/admin/users/') && url.pathname.endsWith('/plan')) {
      try {
        const userId = url.pathname.replace('/admin/users/', '').replace('/plan', '');
        const body = await request.json() as Record<string, any>;
        const plan = body.plan;
        const quota = body.quota_requests;
        if (!plan || !['free', 'pro', 'enterprise'].includes(plan)) {
          return new Response(JSON.stringify({ error: { message: 'Invalid plan' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const updates: string[] = ['plan = ?', 'updated_at = datetime(\'now\')'];
        const params: any[] = [plan];
        if (typeof quota === 'number' && quota > 0) {
          updates.push('quota_requests = ?');
          params.push(quota);
        }
        const result = await env.PLATFORM_DB.prepare(
          `UPDATE users SET ${updates.join(', ')} WHERE id = ?`
        ).bind(...params, userId).run();
        if (result.changes === 0) {
          return new Response(JSON.stringify({ error: { message: 'User not found' } }), {
            status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        return new Response(JSON.stringify({ ok: true, userId, plan, quota: quota || null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Failed to update plan' } }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- Stripe Webhook ---
    if (request.method === 'POST' && url.pathname === '/admin/webhooks/stripe') {
      try {
        const stripeSignature = request.headers.get('Stripe-Signature');
        if (!stripeSignature) {
          return new Response(JSON.stringify({ error: { message: 'Missing Stripe-Signature' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const body = await request.text();
        const event = JSON.parse(body);

        if (event.type === 'invoice.payment_succeeded') {
          const customerEmail = event.data?.object?.customer_email;
          const amount = event.data?.object?.amount_paid / 100;
          const externalId = event.data?.object?.id;
          if (customerEmail) {
            await env.PLATFORM_DB.prepare(
              'UPDATE users SET billing_status = \'active\', updated_at = datetime(\'now\') WHERE email = ?'
            ).bind(customerEmail).run();
            await env.PLATFORM_DB.prepare(
              'INSERT INTO billing_events (user_id, amount, currency, status, provider, external_id, metadata) VALUES (?, ?, ?, ?, ?, ?, ?)'
            ).bind(customerEmail, amount, 'USD', 'paid', 'stripe', externalId, JSON.stringify(event)).run();
          }
        } else if (event.type === 'invoice.payment_failed') {
          const customerEmail = event.data?.object?.customer_email;
          if (customerEmail) {
            await env.PLATFORM_DB.prepare(
              'UPDATE users SET billing_status = \'past_due\', updated_at = datetime(\'now\') WHERE email = ?'
            ).bind(customerEmail).run();
          }
        }

        return new Response(JSON.stringify({ received: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Webhook failed' } }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- User Dashboard ---
    if (request.method === 'GET' && url.pathname === '/dashboard') {
      try {
        const authHeader = request.headers.get('Authorization');
        const apiKeyHeader = request.headers.get('X-API-Key');
        let email: string | null = null;

        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.slice(7);
          const result = await env.PLATFORM_DB.prepare(
            'SELECT email FROM users WHERE api_key = ?'
          ).bind(token).first();
          if (result) email = result.email;
        }
        if (!email && apiKeyHeader) {
          const result = await env.PLATFORM_DB.prepare(
            'SELECT email FROM users WHERE api_key = ?'
          ).bind(apiKeyHeader).first();
          if (result) email = result.email;
        }

        if (!email) {
          return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const user = await env.PLATFORM_DB.prepare(
          'SELECT id, email, plan, quota_requests, quota_used, quota_reset_at, billing_status, created_at FROM users WHERE email = ?'
        ).bind(email).first();

        const usageResult = await env.PLATFORM_DB.prepare(
          'SELECT endpoint, COUNT(*) as count, SUM(tokens_used) as tokens, SUM(cost) as cost, DATE(created_at) as date FROM usage_logs WHERE user_id = ? GROUP BY DATE(created_at), endpoint ORDER BY date DESC LIMIT 30'
        ).bind(email).all();

        const invoicesResult = await env.PLATFORM_DB.prepare(
          'SELECT id, amount, currency, status, provider, created_at FROM billing_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
        ).bind(email).all();

        const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CY Dashboard</title>
<style>
  :root { --bg:#050505; --surface:#0a0a0a; --text:#ffffff; --text-secondary:rgba(255,255,255,0.6); --border:rgba(255,255,255,0.1); --accent:#ffffff; --glow:rgba(255,255,255,0.15); --success:#00ff88; --error:#ff4444; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, sans-serif; min-height: 100%; padding: 20px; }
  .container { max-width: 900px; margin: 0 auto; }
  .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 32px; }
  .logo { font-size: 32px; font-weight: 800; color: var(--accent); letter-spacing: 8px; }
  .plan-badge { padding: 6px 16px; border: 1px solid var(--accent); border-radius: 20px; font-size: 12px; letter-spacing: 2px; text-transform: uppercase; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 24px; margin-bottom: 20px; }
  .card-title { font-size: 12px; color: var(--text-secondary); letter-spacing: 2px; text-transform: uppercase; margin-bottom: 16px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; }
  .stat { text-align: center; }
  .stat-value { font-size: 32px; font-weight: 700; color: var(--accent); }
  .stat-label { font-size: 11px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 1px; margin-top: 4px; }
  .progress-bar { width: 100%; height: 8px; background: rgba(255,255,255,0.1); border-radius: 4px; overflow: hidden; margin-top: 12px; }
  .progress-fill { height: 100%; background: var(--accent); transition: width 0.3s; }
  .api-key { font-family: monospace; font-size: 12px; background: rgba(255,255,255,0.05); padding: 12px; border-radius: 8px; word-break: break-all; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 10px; border-bottom: 1px solid var(--border); }
  th { color: var(--text-secondary); font-weight: 400; text-transform: uppercase; font-size: 11px; letter-spacing: 1px; }
  .btn { padding: 10px 20px; background: var(--accent); color: #050505; border: none; border-radius: 8px; font-weight: 700; font-size: 12px; cursor: pointer; text-transform: uppercase; letter-spacing: 1px; }
  .btn:hover { opacity: 0.9; }
  .btn-secondary { background: transparent; border: 1px solid var(--accent); color: var(--accent); }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
</style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="logo">CY</div>
      <div class="plan-badge">${user.plan || 'free'}</div>
    </div>

    <div class="card">
      <div class="card-title">API Key</div>
      <div class="api-key">${user.api_key || '***'}</div>
      <div class="actions">
        <button class="btn" onclick="navigator.clipboard.writeText('${user.api_key || ''}').then(()=>alert('Copied'))">Copy</button>
        <button class="btn btn-secondary" onclick="alert('Revoke not implemented yet')">Revoke</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Usage</div>
      <div class="stats">
        <div class="stat">
          <div class="stat-value">${user.quota_used || 0}</div>
          <div class="stat-label">Used</div>
        </div>
        <div class="stat">
          <div class="stat-value">${user.quota_requests || 0}</div>
          <div class="stat-label">Limit</div>
        </div>
        <div class="stat">
          <div class="stat-value">${Math.round(((user.quota_used || 0) / (user.quota_requests || 1000)) * 100)}%</div>
          <div class="stat-label">Consumed</div>
        </div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${Math.min(100, Math.round(((user.quota_used || 0) / (user.quota_requests || 1000)) * 100))}%"></div>
      </div>
      <div style="margin-top:12px;font-size:12px;color:var(--text-secondary);">
        Resets: ${new Date(user.quota_reset_at).toLocaleDateString()}
      </div>
    </div>

    <div class="card">
      <div class="card-title">Usage History (30 days)</div>
      <table>
        <tr><th>Date</th><th>Endpoint</th><th>Requests</th><th>Tokens</th></tr>
        ${(usageResult.results || []).map((r: any) => `<tr><td>${r.date}</td><td>${r.endpoint}</td><td>${r.count}</td><td>${r.tokens || 0}</td></tr>`).join('')}
      </table>
    </div>

    <div class="card">
      <div class="card-title">Invoices</div>
      <table>
        <tr><th>Date</th><th>Amount</th><th>Status</th><th>Provider</th></tr>
        ${(invoicesResult.results || []).map((r: any) => `<tr><td>${r.created_at}</td><td>${r.amount} ${r.currency}</td><td>${r.status}</td><td>${r.provider || '-'}</td></tr>`).join('')}
      </table>
    </div>
  </div>
</body>
</html>`;

        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Dashboard failed' } }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- Connect Page ---
    if (request.method === 'GET' && url.pathname === '/') {
      const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>CY Connect</title>
<style>
  :root { --bg:#050505; --surface:#0a0a0a; --text:#ffffff; --text-secondary:rgba(255,255,255,0.6); --border:rgba(255,255,255,0.1); --accent:#ffffff; --glow:rgba(255,255,255,0.15); }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, sans-serif; height: 100%; display: flex; align-items: center; justify-content: center; padding: 20px; }
  .card { max-width: 420px; width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 32px; box-shadow: 0 0 40px var(--glow); }
  .logo { font-size: 48px; font-weight: 800; color: var(--accent); letter-spacing: 12px; text-align: center; margin-bottom: 8px; text-shadow: 0 0 20px var(--glow); }
  .title { font-size: 12px; color: var(--text-secondary); letter-spacing: 4px; text-transform: uppercase; text-align: center; margin-bottom: 28px; font-family: monospace; }
  .input { width: 100%; padding: 14px 16px; background: rgba(255,255,255,0.05); border: 1px solid var(--border); border-radius: 10px; color: var(--text); font-size: 14px; outline: none; margin-bottom: 16px; font-family: monospace; }
  .input:focus { border-color: var(--accent); box-shadow: 0 0 12px var(--glow); }
  .btn { width: 100%; padding: 14px; background: var(--accent); color: #050505; border: none; border-radius: 10px; font-weight: 700; font-size: 13px; letter-spacing: 2px; cursor: pointer; font-family: monospace; text-transform: uppercase; transition: all 0.2s; }
  .btn:hover { box-shadow: 0 0 20px var(--glow); transform: translateY(-2px); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
  .status { margin-top: 16px; font-size: 12px; font-family: monospace; color: var(--text-secondary); min-height: 16px; text-align: center; }
  .status.error { color: #ff4444; }
  .status.success { color: #00ff88; }
  .key-box { margin-top: 16px; padding: 12px; background: rgba(255,255,255,0.03); border: 1px solid var(--border); border-radius: 8px; font-family: monospace; font-size: 11px; word-break: break-all; color: var(--text-secondary); display: none; }
  .hidden { display: none !important; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">CY</div>
    <div class="title">Connect</div>
    <div id="step-email">
      <input type="email" id="email" class="input" placeholder="you@email.com" autocomplete="email">
      <button class="btn" id="connect-btn">Connect CY</button>
      <div class="status" id="status"></div>
    </div>
    <div id="step-key" class="hidden">
      <div class="status success" style="margin-bottom:12px;">Connected!</div>
      <div class="key-box" id="key-box"></div>
      <button class="btn" id="copy-btn" style="margin-top:12px;background:transparent;border:1px solid var(--accent);color:var(--accent);">Copy API Key</button>
      <div class="status" id="key-status"></div>
    </div>
  </div>
<script>
const API_BASE = location.origin;
const emailInput = document.getElementById('email');
const connectBtn = document.getElementById('connect-btn');
const statusEl = document.getElementById('status');
const stepEmail = document.getElementById('step-email');
const stepKey = document.getElementById('step-key');
const keyBox = document.getElementById('key-box');
const copyBtn = document.getElementById('copy-btn');
const keyStatus = document.getElementById('key-status');

function setStatus(el, msg, type = '') {
  el.textContent = msg;
  el.className = 'status' + (type ? ' ' + type : '');
}

connectBtn.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email || !email.includes('@')) {
    setStatus(statusEl, 'Enter a valid email', 'error');
    return;
  }
  connectBtn.disabled = true;
  setStatus(statusEl, 'Connecting...', '');
  try {
    const res = await fetch(API_BASE + '/api/auth/key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed');
    const apiKey = data.user?.apiKey;
    if (!apiKey) throw new Error('No API key returned');
    stepEmail.classList.add('hidden');
    stepKey.classList.remove('hidden');
    keyBox.textContent = apiKey;
    setStatus(keyStatus, 'Save this key in CY: Settings → API Key', 'success');
  } catch (e) {
    setStatus(statusEl, e.message, 'error');
    connectBtn.disabled = false;
  }
});

copyBtn.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(keyBox.textContent);
    setStatus(keyStatus, 'Copied to clipboard', 'success');
  } catch {
    setStatus(keyStatus, 'Copy failed', 'error');
  }
});
</script>
</body>
</html>`;
      return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html', ...corsHeaders },
      });
    }

    return new Response('CY Auth', { status: 404, headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
  },
};
