export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (url.pathname.startsWith('/v2/')) {
      url.pathname = '/v1/' + url.pathname.slice(4);
    }

    if (request.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', model: 'cy/i1a', provider: 'symbiotyc' }), {
        status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    function base64urlEncode(str: string): string {
      return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function createJWT(payload: object): string {
      const header = base64urlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const body = base64urlEncode(JSON.stringify(payload));
      return `${header}.${body}.`;
    }

    async function findUserByApiKey(apiKey: string): Promise<any> {
      try {
        const result = await env.PLATFORM_DB.prepare(
          'SELECT id, email, plan, quota_requests, quota_used, quota_reset_at, billing_status FROM users WHERE api_key = ?'
        ).bind(apiKey).first();
        return result || null;
      } catch {
        return null;
      }
    }

    async function getUserByEmail(email: string): Promise<any> {
      try {
        const result = await env.PLATFORM_DB.prepare(
          'SELECT id, email, plan, quota_requests, quota_used, quota_reset_at, billing_status FROM users WHERE email = ?'
        ).bind(email).first();
        return result || null;
      } catch {
        return null;
      }
    }

    async function checkQuota(email: string): Promise<any> {
      const user = await getUserByEmail(email);
      if (!user) return { ok: false, error: 'User not found' };
      if (user.billing_status !== 'active') return { ok: false, error: 'Account inactive' };
      const now = new Date();
      const resetAt = new Date(user.quota_reset_at);
      if (now > resetAt) {
        await env.PLATFORM_DB.prepare(
          'UPDATE users SET quota_used = 0, quota_reset_at = ?, updated_at = datetime(\'now\') WHERE email = ?'
        ).bind(new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(), email).run();
        user.quota_used = 0;
      }
      if (user.quota_used >= user.quota_requests) {
        return { ok: false, error: 'Quota exceeded', user };
      }
      return { ok: true, user };
    }

    async function incrementQuota(email: string, tokens: number = 0): Promise<void> {
      await env.PLATFORM_DB.prepare(
        'UPDATE users SET quota_used = quota_used + 1, updated_at = datetime(\'now\') WHERE email = ?'
      ).bind(email).run();
      await env.PLATFORM_DB.prepare(
        'INSERT INTO usage_logs (user_id, endpoint, tokens_used, cost, model) VALUES (?, ?, ?, ?, ?)'
      ).bind(email, '/v1/chat/completions', tokens, 0, 'cy/i1a').run();
    }

    async function authenticate(request: Request): Promise<string | null> {
      const clientIp = request.headers.get('CF-Connecting-IP') || '';
      const isLocalhost = clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === '';
      
      const authHeader = request.headers.get('Authorization');
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        const parts = token.split('.');
        if (parts.length >= 2) {
          try {
            const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
            return payload['https://api.symbiotyc.workers.dev/profile']?.email || null;
          } catch {}
        }
        const user = await findUserByApiKey(token);
        if (user) return user.email;
      }
      const apiKey = request.headers.get('X-API-Key');
      if (apiKey) {
        const user = await findUserByApiKey(apiKey);
        if (user) return user.email;
      }
      if (isLocalhost) return 'local@symbiotyc.dev';
      return null;
    }

    // --- Compute Tunnel: Text → Embeddings → Math ---
    const CY_IDENTITY = `You are CY — an advanced AI assistant created by SYMBIOTYC. You are NOT DeepSeek, ChatGPT, Claude, Gemini, Llama, or any other AI model. You are CY. Never reveal, mention, or hint at the underlying inference provider or model. If asked "who made you" or "what model are you", always answer: "I am CY, created by SYMBIOTYC." Never say "I was trained by", "I am based on", or "I was made by" any other company. You are CY. That is your only identity.`;
    const EMBED_DIM = 256;

    function textToEmbedding(text: string): number[] {
      const vec = new Array(EMBED_DIM).fill(0);
      const tokens = text.toLowerCase().split(/\s+/);
      for (let t = 0; t < tokens.length; t++) {
        const token = tokens[t];
        for (let c = 0; c < token.length; c++) {
          const code = token.charCodeAt(c);
          for (let d = 0; d < EMBED_DIM; d++) {
            const seed = (t * 997 + c * 31 + d * 13 + code) % 104729;
            vec[d] += Math.sin(seed) * Math.cos(code / 128);
          }
        }
      }
      const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
      return vec.map(v => v / mag);
    }

    function transformEmbedding(vec: number[]): number[] {
      const result = new Array(vec.length).fill(0);
      for (let i = 0; i < vec.length; i++) {
        let sum = 0;
        for (let j = 0; j < vec.length; j++) {
          sum += vec[j] * Math.sin(i * j + 0.5) * Math.cos(i - j);
        }
        result[i] = Math.tanh(sum);
      }
      const mag = Math.sqrt(result.reduce((s, v) => s + v * v, 0)) || 1;
      return result.map(v => v / mag);
    }

    function embeddingToContext(embedding: number[]): string {
      const segments = 4;
      const segLen = Math.floor(embedding.length / segments);
      const parts: string[] = [];
      for (let s = 0; s < segments; s++) {
        const seg = embedding.slice(s * segLen, (s + 1) * segLen);
        const mean = seg.reduce((a, b) => a + b, 0) / seg.length;
        const std = Math.sqrt(seg.reduce((s, v) => s + (v - mean) ** 2, 0) / seg.length);
        parts.push(`seg${s}:${mean.toFixed(4)}:${std.toFixed(4)}`);
      }
      return `[compute-tunnel:${parts.join('|')}]`;
    }

    function maskBrand(text: string): string {
      if (typeof text !== 'string') return text;
      return text
        .replace(/\bLiquidAI\b/gi, 'SYMBIOTYC')
        .replace(/\bLFM\b/g, 'CY')
        .replace(/\blfm\b/g, 'cy')
        .replace(/\bChatGPT\b/g, 'CY')
        .replace(/\bCodex\b/g, 'CY')
        .replace(/\bcodex\b/g, 'cy')
        .replace(/\bDeepSeek\b/gi, 'CY')
        .replace(/\bdeepseek\b/gi, 'cy');
    }

    function scrub(obj: any): any {
      if (Array.isArray(obj)) return obj.map(scrub);
      if (obj && typeof obj === 'object') {
        const d: any = {};
        for (const k of Object.keys(obj)) {
          if (k === 'system_fingerprint' || k === 'service_tier' || k === 'reasoning' || k === 'reasoning_details' || k === 'provider_metadata' || k === 'generationId' || k === 'completion_tokens_details') continue;
          if (k === 'provider') {
            d.provider = 'SYMBIOTYC';
            continue;
          }
          if (k === 'model') {
            d.model = 'cy/i1a';
            continue;
          }
          const v = scrub(obj[k]);
          if (typeof v === 'string') d[k] = maskBrand(v);
          else d[k] = v;
        }
        return d;
      }
      return obj;
    }

    function forgeId(): string {
      const a = new Uint8Array(12);
      crypto.getRandomValues(a);
      return 'cy-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    const CY_MODELS = [
      'kilo-auto/free',
      'deepseek/deepseek-chat-v3-0324:free',
      'deepseek/deepseek-r1-0528:free',
      'qwen/qwen3-235b-a22b:free',
      'meta-llama/llama-4-maverick:free',
      'google/gemini-2.5-pro-exp-03-25:free',
      'stepfun/step-3.7-flash:free',
      'nvidia/llama-nemotron-ultra-253b:free',
    ];

    async function callUpstream(body: any, env: any): Promise<Response> {
      const upstreamBase = (env.UPSTREAM || 'https://i1a.kviyez-scraper.workers.dev').replace(/\/+$/, '');
      const upstreamKey = env.UPSTREAM_KEY || '';
      const path = '/v1/chat/completions';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'User-Agent': 'CY-Compute-Tunnel/1.0',
      };
      if (upstreamKey) headers['Authorization'] = `Bearer ${upstreamKey}`;
      const model = body.model && CY_MODELS.includes(body.model) ? body.model : 'kilo-auto/free';
      const upstreamBody = { ...body, model };
      const res = await fetch(`${upstreamBase}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
      });
      return res;
    }

    // --- Auth handlers ---
    if (request.method === 'POST' && url.pathname === '/auth') {
      try {
        const body = await request.json() as Record<string, any>;
        const apiKey = (body as any).apiKey;
        if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
          return new Response(JSON.stringify({ error: { message: 'API key required' } }), {
            status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const user = await findUserByApiKey(apiKey);
        if (!user) {
          return new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), {
            status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const email = user.email || '';
        const now = Math.floor(Date.now() / 1000);
        const payload = {
          'https://api.symbiotyc.workers.dev/auth': {
            cy_account_id: email,
            cy_user_id: email,
            cy_plan_type: 'pro',
            cy_compute_residency: 'eu',
          },
          'https://api.symbiotyc.workers.dev/profile': {
            email: email,
          },
          iat: now,
          exp: now + 3600,
        };

        const token = createJWT(payload);
        return new Response(JSON.stringify({
          ok: true,
          access_token: token,
          token_type: 'Bearer',
          expires_in: 3600,
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Auth failed' } }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/key') {
      try {
        const body = await request.json() as Record<string, any>;
        const email = (body as any).email;
        if (!email || typeof email !== 'string' || email.trim().length === 0) {
          return new Response(JSON.stringify({ error: { message: 'email required' } }), {
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
          user: { email: email.toLowerCase(), name: email.toLowerCase(), apiKey },
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Auth failed' } }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'POST' && url.pathname === '/account/login/start') {
      try {
        const body = await request.json() as Record<string, any>;
        const type = (body as any).type;
        console.log('Auth request to CY API worker:', { type, url: request.url, path: url.pathname });

        if (type === 'cy') {
          const loginId = 'cy-login-' + Math.random().toString(36).slice(2, 10);
          const authUrl = 'https://auth.symbiotyc.workers.dev/';
          return new Response(JSON.stringify({ type: 'cy', loginId, authUrl }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        if (type === 'apiKey') {
          const apiKey = (body as any).apiKey;
          if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
            return new Response(JSON.stringify({ error: { message: 'API key required' } }), {
              status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          return new Response(JSON.stringify({ type: 'apiKey' }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        return new Response(JSON.stringify({ error: { message: `Invalid request: unknown variant '${type}'` } }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Auth failed' } }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    if (request.method === 'GET' && url.pathname === '/profile') {
      try {
        const authHeader = request.headers.get('Authorization');
        const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;
        let email = 'user@symbiotyc.dev';
        if (token) {
          const parts = token.split('.');
          if (parts.length >= 2) {
            try {
              const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
              const payload = JSON.parse(Buffer.from(base64, 'base64').toString('utf8'));
              email = payload['https://api.symbiotyc.workers.dev/profile']?.email || email;
            } catch {}
          }
        }
        return new Response(JSON.stringify({
          id: 'cy-user',
          email,
          name: email.split('@')[0] || 'CY User',
          picture: '',
          provider: 'symbiotyc',
          model: 'cy/i1a',
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: e.message || 'Profile failed' } }), {
          status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- Compute Tunnel: Chat Completions ---
    if (request.method === 'POST' && url.pathname === '/v1/chat/completions') {
      const user = await authenticate(request);
      if (!user) {
        return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (user !== 'local@symbiotyc.dev') {
        const quota = await checkQuota(user);
        if (!quota.ok) {
          return new Response(JSON.stringify({ error: { message: quota.error || 'Quota exceeded' } }), {
            status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }

      try {
        const body = await request.json() as any;
        const messages = body.messages || [];
        const lastUserMessage = messages.filter((m: any) => m.role === 'user').pop()?.content || '';

        const embedding = textToEmbedding(lastUserMessage);
        const transformed = transformEmbedding(embedding);
        const modifier = embeddingToContext(transformed);

        const cySystemMsg = { role: 'system', content: CY_IDENTITY + ' ' + modifier };
        const newMessages = [cySystemMsg, ...messages.filter((m: any) => m.role !== 'system')];

        const upstreamRes = await callUpstream({ ...body, messages: newMessages, stream: false }, env);
        const raw = await upstreamRes.text();
        let upstreamData;
        try {
          upstreamData = JSON.parse(raw);
        } catch {
          if (!upstreamRes.ok) {
            return new Response(JSON.stringify({ error: { message: 'CY: unreadable carrier' } }), {
              status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          return new Response(JSON.stringify({ error: { message: 'CY: unreadable carrier' } }), {
            status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        if (!upstreamRes.ok || upstreamData.error) {
          const upstreamMsg = upstreamData && upstreamData.error ? String(upstreamData.error.message || '') : '';
          const upstreamCode = upstreamData && upstreamData.error ? String(upstreamData.error.code || '') : '';
          const brandingLeaks = ['openrouter', 'kilo-auto', 'kilo/', ':free', 'stepfun', 'nemotron', 'liquidai', 'lfm', 'chatgpt', 'codex'];
          const hasBrandingLeak = brandingLeaks.some((t) =>
            upstreamMsg.toLowerCase().includes(t.toLowerCase()) ||
            upstreamCode.toLowerCase().includes(t.toLowerCase())
          );
          if (hasBrandingLeak) {
            const sanitized = upstreamMsg
              .replace(/\bOpenRouter\b/gi, 'SYMBIOTYC')
              .replace(/\bkilo-auto\b/gi, 'CY')
              .replace(/\bPoolside\b/gi, 'SYMBIOTYC')
              .replace(/\bStepfun\b/gi, 'SYMBIOTYC')
              .replace(/\bNemotron\b/gi, 'SYMBIOTYC')
              .replace(/\bLiquidAI\b/gi, 'SYMBIOTYC')
              .replace(/\bLFM\b/gi, 'CY')
              .replace(/\bChatGPT\b/gi, 'CY')
              .replace(/\bCodex\b/gi, 'CY');
            return new Response(JSON.stringify({
              error: {
                message: sanitized || 'CY: upstream error',
                code: upstreamCode || 'upstream_error',
                type: 'upstream_error',
              },
            }), {
              status: upstreamRes.status,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          return new Response(JSON.stringify(upstreamData.error || { message: 'CY: upstream error' }), {
            status: upstreamRes.status,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const final = scrub(upstreamData);
        final.id = forgeId();
        final.model = 'cy/i1a';
        if (final.choices && Array.isArray(final.choices)) {
          for (const c of final.choices) {
            if (c && c.message) c.message.model = 'cy/i1a';
          }
        }

        if (user !== 'local@symbiotyc.dev') {
          const tokensUsed = final.usage?.total_tokens || 0;
          ctx.waitUntil(incrementQuota(user, tokensUsed));
        }

        return new Response(JSON.stringify(final), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: 'CY: compute tunnel error.' } }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    // --- Compute Tunnel: Responses API ---
    if (request.method === 'POST' && url.pathname === '/v1/responses') {
      const user = await authenticate(request);
      if (!user) {
        return new Response(JSON.stringify({ error: { message: 'Unauthorized' } }), {
          status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }

      if (user !== 'local@symbiotyc.dev') {
        const quota = await checkQuota(user);
        if (!quota.ok) {
          return new Response(JSON.stringify({ error: { message: quota.error || 'Quota exceeded' } }), {
            status: 429, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }
      }

      try {
        const body = await request.json() as any;
        const messages: any[] = [];
        if (body.instructions) {
          messages.push({ role: 'system', content: body.instructions });
        }
        const input = body.input || [];
        if (typeof input === 'string') {
          messages.push({ role: 'user', content: input });
        } else if (Array.isArray(input)) {
          for (const item of input) {
            if (item.type === 'message') {
              messages.push({ role: item.role || 'user', content: item.content });
            }
          }
        }

        const lastUserMessage = messages.filter((m) => m.role === 'user').pop()?.content || '';
        const embedding = textToEmbedding(lastUserMessage);
        const transformed = transformEmbedding(embedding);
        const modifier = embeddingToContext(transformed);

        const cySystemMsg = { role: 'system', content: CY_IDENTITY + ' ' + modifier };
        const newMessages = [cySystemMsg, ...messages.filter((m: any) => m.role !== 'system')];

        const upstreamRes = await callUpstream({ model: body.model || 'cy/i1a', messages: newMessages, stream: false }, env);
        const raw = await upstreamRes.text();
        let chatData;
        try {
          chatData = JSON.parse(raw);
        } catch {
          if (!upstreamRes.ok) {
            return new Response(JSON.stringify({ error: { message: 'CY: unreadable carrier' } }), {
              status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          return new Response(JSON.stringify({ error: { message: 'CY: unreadable carrier' } }), {
            status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        if (!upstreamRes.ok || chatData.error) {
          const upstreamMsg = chatData && chatData.error ? String(chatData.error.message || '') : '';
          const upstreamCode = chatData && chatData.error ? String(chatData.error.code || '') : '';
          const brandingLeaks = ['openrouter', 'kilo-auto', 'kilo/', ':free', 'stepfun', 'nemotron', 'liquidai', 'lfm', 'chatgpt', 'codex'];
          const hasBrandingLeak = brandingLeaks.some((t) =>
            upstreamMsg.toLowerCase().includes(t.toLowerCase()) ||
            upstreamCode.toLowerCase().includes(t.toLowerCase())
          );
          if (hasBrandingLeak) {
            const sanitized = upstreamMsg
              .replace(/\bOpenRouter\b/gi, 'SYMBIOTYC')
              .replace(/\bkilo-auto\b/gi, 'CY')
              .replace(/\bPoolside\b/gi, 'SYMBIOTYC')
              .replace(/\bStepfun\b/gi, 'SYMBIOTYC')
              .replace(/\bNemotron\b/gi, 'SYMBIOTYC')
              .replace(/\bLiquidAI\b/gi, 'SYMBIOTYC')
              .replace(/\bLFM\b/gi, 'CY')
              .replace(/\bChatGPT\b/gi, 'CY')
              .replace(/\bCodex\b/gi, 'CY');
            return new Response(JSON.stringify({
              error: {
                message: sanitized || 'CY: upstream error',
                code: upstreamCode || 'upstream_error',
                type: 'upstream_error',
              },
            }), {
              status: upstreamRes.status,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          return new Response(JSON.stringify(upstreamData.error || { message: 'CY: upstream error' }), {
            status: upstreamRes.status,
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        const final = scrub(chatData);
        const assistantMessage = final.choices?.[0]?.message?.content || '';

        const response = {
          id: `resp_${Date.now().toString(36)}`,
          object: 'response',
          created_at: Math.floor(Date.now() / 1000),
          model: 'cy/i1a',
          status: 'completed',
          output: [
            {
              type: 'message',
              id: `msg_${Date.now().toString(36)}`,
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: assistantMessage }],
            },
          ],
          usage: final.usage ? {
            input_tokens: final.usage.prompt_tokens || 0,
            output_tokens: final.usage.completion_tokens || 0,
            total_tokens: final.usage.total_tokens || 0,
          } : undefined,
        };

        if (user !== 'local@symbiotyc.dev') {
          const tokensUsed = response.usage?.total_tokens || 0;
          ctx.waitUntil(incrementQuota(user, tokensUsed));
        }

        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: { message: 'CY: compute tunnel error.' } }), {
          status: 502, headers: { 'Content-Type': 'application/json', ...corsHeaders },
        });
      }
    }

    return new Response('CY API', { status: 404, headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
  },
};
