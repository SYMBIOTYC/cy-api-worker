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

    function base64urlEncode(str: string): string {
      return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function createJWT(payload: object): string {
      const header = base64urlEncode(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const body = base64urlEncode(JSON.stringify(payload));
      return `${header}.${body}.`;
    }

    async function findUserByApiKey(apiKey: string): Promise<any> {
      const email = await env.PLATFORM_KV.get(`apikey:${apiKey}`, { type: 'text' });
      if (!email) return null;
      const userKey = `user:${email}`;
      const user = await env.PLATFORM_KV.get(userKey, { type: 'json' });
      return user;
    }

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

    if (request.method === 'POST' && url.pathname === '/account/login/start') {
      try {
        const body = await request.json() as Record<string, any>;
        const type = (body as any).type;
        
        // Log for debugging
        console.log('Auth request to CY API worker:', {
          type,
          fullBody: JSON.stringify(body),
          url: request.url,
          method: request.method,
          path: url.pathname
        });

        if (type === 'cy') {
          const loginId = 'cy-login-' + Math.random().toString(36).slice(2, 10);
          const authUrl = 'https://platform.symbiotyc.workers.dev/api-keys';
          return new Response(JSON.stringify({
            type: 'cy',
            loginId,
            authUrl,
          }), {
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
          return new Response(JSON.stringify({
            type: 'apiKey',
          }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders },
          });
        }

        return new Response(JSON.stringify({ error: { message: `Invalid request: unknown variant '${type}', expected one of 'cy', 'apiKey'` } }), {
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

    return new Response('CY API', { status: 404, headers: { 'Content-Type': 'text/plain', ...corsHeaders } });
  },
};
