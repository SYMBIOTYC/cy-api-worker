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

    // --- Google OAuth: Redirect to Google ---
    if (request.method === 'GET' && url.pathname === '/auth/google') {
      const clientId = env.GOOGLE_CLIENT_ID;
      const redirectUri = origin + '/auth/google/callback';
      const state = crypto.randomUUID();
      const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=openid email profile&state=${state}&access_type=offline&prompt=consent`;
      return Response.redirect(googleAuthUrl, 302);
    }

    // --- Google OAuth: Callback ---
    if (request.method === 'GET' && url.pathname === '/auth/google/callback') {
      try {
        const code = url.searchParams.get('code');
        if (!code) {
          return new Response('Missing code', { status: 400 });
        }

        const clientId = env.GOOGLE_CLIENT_ID;
        const clientSecret = env.GOOGLE_CLIENT_SECRET;
        const redirectUri = origin + '/auth/google/callback';

        // Exchange code for tokens
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code,
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
          }),
        });
        const tokenData = await tokenRes.json() as any;
        if (!tokenData.access_token) {
          return new Response('Token exchange failed: ' + JSON.stringify(tokenData), { status: 400 });
        }

        // Get user info from Google
        const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
          headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const googleUser = await userRes.json() as any;
        const email = googleUser.email;
        if (!email) {
          return new Response('No email from Google', { status: 400 });
        }

        // Find or create user in D1
        const existing = await env.PLATFORM_DB.prepare(
          'SELECT api_key FROM users WHERE email = ?'
        ).bind(email).first();

        let apiKey = existing?.api_key;
        let isNew = false;
        if (!apiKey) {
          apiKey = 'cfat_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
          isNew = true;
          await env.PLATFORM_DB.prepare(
            'INSERT INTO users (id, email, api_key, plan, quota_requests, quota_used, quota_reset_at, billing_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
          ).bind(
            'user-' + crypto.randomUUID(),
            email,
            apiKey,
            'free',
            1000,
            0,
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            'active'
          ).run();
        }

        // Redirect to dashboard with API key shown
        const dashUrl = new URL(origin + '/dashboard');
        dashUrl.searchParams.set('key', apiKey);
        return Response.redirect(dashUrl.toString(), 302);
      } catch (e: any) {
        return new Response('Auth error: ' + e.message, { status: 500 });
      }
    }

    // --- API Key by email (for CLI / programmatic access) ---
    if (request.method === 'POST' && url.pathname === '/api/auth/key') {
      try {
        const body = await request.json() as Record<string, any>;
        const email = body.email;
        if (!email || typeof email !== 'string' || !email.includes('@')) {
          return new Response(JSON.stringify({ error: { message: 'Valid email required' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const existing = await env.PLATFORM_DB.prepare(
          'SELECT api_key FROM users WHERE email = ?'
        ).bind(email).first();
        let apiKey = existing?.api_key;
        if (!apiKey) {
          apiKey = 'cfat_' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
          await env.PLATFORM_DB.prepare(
            'INSERT INTO users (id, email, api_key, plan, quota_requests, quota_used, quota_reset_at, billing_status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'), datetime(\'now\'))'
          ).bind(
            'user-' + crypto.randomUUID(),
            email,
            apiKey,
            'free',
            1000,
            0,
            new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
            'active'
          ).run();
        }
        return new Response(JSON.stringify({ user: { email, apiKey } }), {
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

    // --- List Billing Events ---
    if (request.method === 'GET' && url.pathname === '/admin/billing') {
      try {
        const result = await env.PLATFORM_DB.prepare(
          'SELECT id, user_id, amount, currency, status, provider, external_id, metadata, created_at FROM billing_events ORDER BY created_at DESC LIMIT 100'
        ).all();
        const events = result.results.map((row: any) => ({
          id: row.id,
          userId: row.user_id,
          amount: row.amount,
          currency: row.currency,
          status: row.status,
          provider: row.provider,
          externalId: row.external_id,
          metadata: row.metadata ? JSON.parse(row.metadata) : null,
          createdAt: row.created_at,
        }));
        return new Response(JSON.stringify({ events, count: events.length }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: 'Failed to list billing events' } }), {
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

    // --- User Usage Stats ---
    if (request.method === 'GET' && url.pathname.startsWith('/admin/users/') && url.pathname.endsWith('/usage')) {
      try {
        const userId = url.pathname.replace('/admin/users/', '').replace('/usage', '');
        const user = await env.PLATFORM_DB.prepare(
          'SELECT id, email, plan, quota_requests, quota_used, quota_reset_at, billing_status, created_at FROM users WHERE id = ?'
        ).bind(userId).first();
        if (!user) {
          return new Response(JSON.stringify({ error: { message: 'User not found' } }), {
            status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
        const usageResult = await env.PLATFORM_DB.prepare(
          'SELECT endpoint, COUNT(*) as count, SUM(tokens_used) as tokens, SUM(cost) as cost, DATE(created_at) as date FROM usage_logs WHERE user_id = ? GROUP BY DATE(created_at), endpoint ORDER BY date DESC LIMIT 30'
        ).bind(user.email).all();
        const totalTokens = usageResult.results.reduce((sum: number, r: any) => sum + (r.tokens || 0), 0);
        const totalRequests = usageResult.results.reduce((sum: number, r: any) => sum + (r.count || 0), 0);
        return new Response(JSON.stringify({
          user: { id: user.id, email: user.email, plan: user.plan, quotaRequests: user.quota_requests, quotaUsed: user.quota_used, quotaResetAt: user.quota_reset_at, billingStatus: user.billing_status, createdAt: user.created_at },
          usage: usageResult.results,
          totals: { requests: totalRequests, tokens: totalTokens },
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: 'Failed to get usage' } }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- Billing Dashboard HTML ---
    if (request.method === 'GET' && url.pathname === '/admin/billing/html') {
      try {
        const usersResult = await env.PLATFORM_DB.prepare(
          'SELECT id, email, plan, quota_requests, quota_used, billing_status, created_at FROM users ORDER BY created_at DESC'
        ).all();
        const billingResult = await env.PLATFORM_DB.prepare(
          'SELECT id, user_id, amount, currency, status, provider, created_at FROM billing_events ORDER BY created_at DESC LIMIT 50'
        ).all();
        const users = usersResult.results.map((r: any) => `<tr><td>${r.email}</td><td>${r.plan}</td><td>${r.quota_used}/${r.quota_requests}</td><td>${r.billing_status}</td><td>${r.created_at}</td></tr>`).join('');
        const events = billingResult.results.map((r: any) => `<tr><td>${r.user_id}</td><td>${r.amount} ${r.currency}</td><td>${r.status}</td><td>${r.provider}</td><td>${r.created_at}</td></tr>`).join('');
        const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>CY Billing</title><style>body{font-family:-apple-system,sans-serif;background:#050505;color:#fff;padding:20px}h1{letter-spacing:4px}table{width:100%;border-collapse:collapse;margin:16px 0}th,td{text-align:left;padding:8px;border-bottom:1px solid rgba(255,255,255,0.1);font-size:13px}th{color:rgba(255,255,255,0.5);text-transform:uppercase;font-size:11px}.card{background:#0a0a0a;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:20px;margin:16px 0}</style></head><body><h1>CY Billing</h1><div class="card"><h2>Users</h2><table><tr><th>Email</th><th>Plan</th><th>Quota</th><th>Status</th><th>Created</th></tr>${users}</table></div><div class="card"><h2>Billing Events</h2><table><tr><th>User</th><th>Amount</th><th>Status</th><th>Provider</th><th>Date</th></tr>${events}</table></div></body></html>`;
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: 'Failed to render billing' } }), {
          status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- User Dashboard ---
    if (request.method === 'GET' && url.pathname === '/dashboard') {
      try {
        // Get API key from query param or header
        let apiKey = url.searchParams.get('key');
        if (!apiKey) {
          const authHeader = request.headers.get('Authorization');
          const apiKeyHeader = request.headers.get('X-API-Key');
          if (authHeader?.startsWith('Bearer ')) apiKey = authHeader.slice(7);
          if (!apiKey && apiKeyHeader) apiKey = apiKeyHeader;
        }

        if (!apiKey) {
          return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const user = await env.PLATFORM_DB.prepare(
          'SELECT id, email, api_key, plan, quota_requests, quota_used, quota_reset_at, billing_status, created_at FROM users WHERE api_key = ?'
        ).bind(apiKey).first();

        if (!user) {
          return new Response(JSON.stringify({ error: { message: 'User not found' } }), {
            status: 404, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const usageResult = await env.PLATFORM_DB.prepare(
          'SELECT endpoint, COUNT(*) as count, SUM(tokens_used) as tokens, SUM(cost) as cost, DATE(created_at) as date FROM usage_logs WHERE user_id = ? GROUP BY DATE(created_at), endpoint ORDER BY date DESC LIMIT 30'
        ).bind(user.email).all();

        const invoicesResult = await env.PLATFORM_DB.prepare(
          'SELECT id, amount, currency, status, provider, created_at FROM billing_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 10'
        ).bind(user.email).all();

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
      <div class="card-title">Email</div>
      <div style="font-size:14px;">${user.email}</div>
    </div>

    <div class="card">
      <div class="card-title">API Key</div>
      <div class="api-key">${user.api_key || '***'}</div>
      <div class="actions">
        <button class="btn" onclick="navigator.clipboard.writeText('${user.api_key || ''}').then(()=>alert('Copied'))">Copy</button>
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

    // --- Connect Page (Sign with Google) ---
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
  .card { max-width: 420px; width: 100%; background: var(--surface); border: 1px solid var(--border); border-radius: 16px; padding: 32px; box-shadow: 0 0 40px var(--glow); text-align: center; }
  .logo { font-size: 48px; font-weight: 800; color: var(--accent); letter-spacing: 12px; text-align: center; margin-bottom: 8px; text-shadow: 0 0 20px var(--glow); }
  .title { font-size: 12px; color: var(--text-secondary); letter-spacing: 4px; text-transform: uppercase; text-align: center; margin-bottom: 28px; font-family: monospace; }
  .google-btn { display: inline-flex; align-items: center; gap: 10px; padding: 12px 24px; background: #ffffff; color: #000000; border: none; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; transition: all 0.2s; }
  .google-btn:hover { box-shadow: 0 0 20px var(--glow); transform: translateY(-2px); }
  .google-icon { width: 20px; height: 20px; }
  .status { margin-top: 16px; font-size: 12px; font-family: monospace; color: var(--text-secondary); min-height: 16px; text-align: center; }
  .status.error { color: #ff4444; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo">CY</div>
    <div class="title">Connect</div>
    <a href="${origin}/auth/google" class="google-btn">
      <svg class="google-icon" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
      Sign with Google
    </a>
    <div class="status" id="status"></div>
  </div>
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
