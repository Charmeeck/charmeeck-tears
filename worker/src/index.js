import { DurableObject } from 'cloudflare:workers';

const DA_API = 'https://www.donationalerts.com/api/v1';
const DA_OAUTH = 'https://www.donationalerts.com/oauth';
const DA_WS = 'wss://centrifugo.donationalerts.com/connection/websocket';
const OAUTH_SCOPES = 'oauth-user-show oauth-donation-subscribe';
const CURRENCIES = new Set(['RUB','USD','EUR','KZT','UAH','BYN','BRL','TRY']);
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }, headers)
  });
}
function corsHeaders(request, env) {
  const h = new Headers({
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400'
  });
  const origin = request.headers.get('Origin');
  if (origin && origin === env.ALLOWED_ORIGIN) h.set('Access-Control-Allow-Origin', origin);
  return h;
}
function withCors(response, request, env) {
  const headers = new Headers(response.headers);
  for (const [key, value] of corsHeaders(request, env)) headers.set(key, value);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
function originAllowed(request, env) {
  const origin = request.headers.get('Origin');
  return !origin || origin === env.ALLOWED_ORIGIN;
}
function randomHex(bytes = 32) {
  const data = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(data, value => value.toString(16).padStart(2, '0')).join('');
}
function toBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
async function encryptionKey(env) {
  if (!env.APP_ENCRYPTION_KEY) throw new Error('Не задан APP_ENCRYPTION_KEY.');
  const raw = fromBase64(env.APP_ENCRYPTION_KEY.trim());
  if (raw.length !== 32) throw new Error('APP_ENCRYPTION_KEY должен быть Base64 от 32 случайных байт.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
}
async function encryptJson(env, value) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const packed = new Uint8Array(iv.length + ciphertext.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(ciphertext), iv.length);
  return toBase64(packed);
}
async function decryptJson(env, packedValue) {
  const key = await encryptionKey(env);
  const packed = fromBase64(packedValue);
  if (packed.length < 29) throw new Error('Повреждён зашифрованный блок.');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: packed.slice(0, 12) },
    key,
    packed.slice(12)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
async function readJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
}
async function daFetch(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('DonationAlerts: ' + (data.message || data.error_description || ('HTTP ' + response.status)));
  }
  return data;
}
function workerBase(env) {
  return String(env.WORKER_BASE_URL || '').replace(/\/+$/, '');
}
function authToken(request) {
  const match = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}
async function accountFromSession(request, env) {
  const token = authToken(request);
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(
    'SELECT a.account_id,a.da_user_id,a.username,a.payload_enc,a.current_amount,a.goal_amount,a.currency,a.widget_key_hash,a.widget_key_enc,a.created_at,a.updated_at ' +
    'FROM sessions s JOIN accounts a ON a.account_id=s.account_id ' +
    'WHERE s.token_hash=? AND s.expires_at>?'
  ).bind(tokenHash, Date.now()).first();
}
async function accountFromWidgetKey(key, env) {
  if (!key || String(key).length < 32 || String(key).length > 128) return null;
  const hash = await sha256Hex(key);
  return env.DB.prepare(
    'SELECT account_id,da_user_id,username,current_amount,goal_amount,currency ' +
    'FROM accounts WHERE widget_key_hash=?'
  ).bind(hash).first();
}
async function readAccountTokens(accountId, env) {
  const row = await env.DB.prepare('SELECT payload_enc FROM accounts WHERE account_id=?').bind(accountId).first();
  return row && row.payload_enc ? decryptJson(env, row.payload_enc) : null;
}
async function writeAccountTokens(accountId, tokenData, env) {
  const encrypted = await encryptJson(env, tokenData);
  await env.DB.prepare(
    'UPDATE accounts SET payload_enc=?,token_expires_at=?,username=?,updated_at=? WHERE account_id=?'
  ).bind(
    encrypted,
    Number(tokenData.expires_at || 0),
    String(tokenData.username || 'DonationAlerts'),
    new Date().toISOString(),
    accountId
  ).run();
}
function listener(env, accountId) {
  return env.LISTENER.get(env.LISTENER.idFromName(String(accountId)));
}
async function listenerCommand(env, accountId, path) {
  return listener(env, accountId).fetch('https://listener.internal' + path, {
    method: 'POST',
    headers: { 'x-tears-internal': env.INTERNAL_SECRET || '', 'x-account-id': String(accountId) }
  });
}
function validateAmounts(body) {
  const current = Number(body.current_amount);
  const goal = Number(body.goal_amount);
  const currency = String(body.currency || 'RUB').toUpperCase();
  if (!Number.isFinite(current) || current < 0 || current > 1e12 ||
      !Number.isFinite(goal) || goal <= 0 || goal > 1e12 || !CURRENCIES.has(currency)) {
    return { error: 'Проверь текущую сумму, цель и валюту.' };
  }
  return { current, goal, currency };
}
function widgetUrl(env, key) {
  const base = String(env.WIDGET_PAGE_URL || '');
  const url = new URL(base);
  url.searchParams.set('key', key);
  return url.toString();
}
async function createOwnerSession(accountId, env) {
  const token = randomHex(32);
  const hash = await sha256Hex(token);
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await env.DB.prepare(
    'INSERT INTO sessions (token_hash,account_id,expires_at,created_at) VALUES (?,?,?,?)'
  ).bind(hash, accountId, expiresAt, new Date().toISOString()).run();
  return token;
}
async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/health' && request.method === 'GET') {
    return json({ ok: true, service: 'Tears multi-stream DonationAlerts Worker', version: '2.3' });
  }

  if (path === '/api/oauth/start' && request.method === 'POST') {
    if (!env.DA_CLIENT_ID || !env.DA_CLIENT_SECRET) {
      return json({ ok: false, error: 'В Cloudflare ещё не заданы DA_CLIENT_ID и DA_CLIENT_SECRET.' }, 503);
    }
    const body = await readJson(request);
    const amounts = validateAmounts(body);
    if (amounts.error) return json({ ok: false, error: amounts.error }, 400);
    const clientNonce = String(body.client_nonce || '');
    if (!/^[a-f0-9]{64}$/i.test(clientNonce)) return json({ ok: false, error: 'Не удалось подтвердить браузерную сессию. Обнови страницу и попробуй ещё раз.' }, 400);

    await env.DB.prepare('DELETE FROM oauth_state WHERE expires_at<?').bind(Date.now()).run();
    const state = randomHex(32);
    await env.DB.prepare(
      'INSERT INTO oauth_state (state,current_amount,goal_amount,currency,client_nonce,expires_at,created_at) VALUES (?,?,?,?,?,?,?)'
    ).bind(
      state, amounts.current, amounts.goal, amounts.currency, clientNonce,
      Date.now() + 10 * 60 * 1000, new Date().toISOString()
    ).run();

    const params = new URLSearchParams({
      client_id: env.DA_CLIENT_ID,
      redirect_uri: workerBase(env) + '/oauth/callback',
      response_type: 'code',
      scope: OAUTH_SCOPES,
      state
    });
    return json({ ok: true, authorize_url: DA_OAUTH + '/authorize?' + params.toString() });
  }

  if (path === '/oauth/callback' && request.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    if (oauthError) return new Response('DonationAlerts отменил подключение: ' + oauthError, { status: 400 });
    if (!code || !state) return new Response('DonationAlerts не вернул code или state.', { status: 400 });

    const savedState = await env.DB.prepare(
      'SELECT current_amount,goal_amount,currency,client_nonce,expires_at FROM oauth_state WHERE state=?'
    ).bind(state).first();
    await env.DB.prepare('DELETE FROM oauth_state WHERE state=?').bind(state).run();
    if (!savedState || Number(savedState.expires_at) < Date.now()) {
      return new Response('Ссылка авторизации устарела. Вернись в панель и нажми подключение ещё раз.', { status: 400 });
    }

    try {
      const tokenData = await daFetch(DA_OAUTH + '/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.DA_CLIENT_ID,
          client_secret: env.DA_CLIENT_SECRET,
          redirect_uri: workerBase(env) + '/oauth/callback',
          code
        })
      });
      if (!tokenData.access_token) throw new Error('DonationAlerts не вернул access_token.');

      const profileResponse = await daFetch(DA_API + '/user/oauth', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token, Accept: 'application/json' }
      });
      const profile = profileResponse.data || {};
      if (!profile.id || !profile.socket_connection_token) {
        throw new Error('Не получен профиль или Centrifugo token. Проверь разрешения приложения.');
      }

      const userId = String(profile.id);
      const username = String(profile.name || profile.code || 'DonationAlerts').slice(0, 100);
      const existing = await env.DB.prepare('SELECT account_id,widget_key_hash,widget_key_enc FROM accounts WHERE da_user_id=?')
        .bind(userId).first();
      const accountId = existing ? String(existing.account_id) : randomHex(16);
      const widgetKey = existing && existing.widget_key_enc
        ? await decryptJson(env, existing.widget_key_enc)
        : randomHex(32);
      const widgetHash = await sha256Hex(widgetKey);
      const widgetEncrypted = await encryptJson(env, widgetKey);
      const tokenRecord = {
        access_token: tokenData.access_token,
        refresh_token: tokenData.refresh_token || '',
        expires_at: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
        user_id: userId,
        username
      };
      const tokenEncrypted = await encryptJson(env, tokenRecord);
      const now = new Date().toISOString();

      if (existing) {
        await env.DB.prepare(
          'UPDATE accounts SET username=?,payload_enc=?,token_expires_at=?,current_amount=?,goal_amount=?,currency=?,updated_at=? WHERE account_id=?'
        ).bind(
          username, tokenEncrypted, tokenRecord.expires_at,
          Number(savedState.current_amount), Number(savedState.goal_amount), String(savedState.currency),
          now, accountId
        ).run();
        if (!existing.widget_key_hash || !existing.widget_key_enc) {
          await env.DB.prepare('UPDATE accounts SET widget_key_hash=?,widget_key_enc=? WHERE account_id=?')
            .bind(widgetHash, widgetEncrypted, accountId).run();
        }
      } else {
        await env.DB.prepare(
          'INSERT INTO accounts (account_id,da_user_id,username,payload_enc,token_expires_at,current_amount,goal_amount,currency,widget_key_hash,widget_key_enc,created_at,updated_at) ' +
          'VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'
        ).bind(
          accountId, userId, username, tokenEncrypted, tokenRecord.expires_at,
          Number(savedState.current_amount), Number(savedState.goal_amount), String(savedState.currency),
          widgetHash, widgetEncrypted, now, now
        ).run();
      }

      const sessionToken = await createOwnerSession(accountId, env);
      const started = await listenerCommand(env, accountId, '/start');
      if (!started.ok) throw new Error('Аккаунт авторизован, но не удалось запустить приём донатов.');

      const destination = new URL(String(env.ADMIN_PAGE_URL || ''));
      destination.hash = 'session=' + encodeURIComponent(sessionToken) + '&nonce=' + encodeURIComponent(String(savedState.client_nonce));
      return Response.redirect(destination.toString(), 302);
    } catch (error) {
      console.error('DonationAlerts OAuth callback failed:', error && error.message || error);
      return new Response(
        'Не удалось завершить подключение DonationAlerts. Проверь Client ID/Secret и разрешения. Подробности смотри в Worker Logs.',
        { status: 502 }
      );
    }
  }

  if (path === '/api/state' && request.method === 'GET') {
    const account = await accountFromWidgetKey(url.searchParams.get('key') || '', env);
    if (!account) return json({ ok: false, error: 'Неверная ссылка виджета.' }, 404);
    return json({
      current_amount: Number(account.current_amount),
      goal_amount: Number(account.goal_amount),
      currency: String(account.currency || 'RUB'),
      username: String(account.username || '')
    });
  }

  if (path === '/api/me' && request.method === 'GET') {
    const account = await accountFromSession(request, env);
    if (!account) return json({ ok: false, error: 'Сессия завершилась. Подключи DonationAlerts заново.' }, 401);
    const widgetKey = await decryptJson(env, account.widget_key_enc);
    const state = await listener(env, account.account_id).fetch('https://listener.internal/status', {
      headers: { 'x-tears-internal': env.INTERNAL_SECRET || '', 'x-account-id': account.account_id }
    });
    const listenerStatus = await state.json().catch(() => ({}));
    const donations = await env.DB.prepare(
      'SELECT donation_id AS id,username,amount,currency,message,created_at,counted FROM donations ' +
      'WHERE account_id=? ORDER BY created_at DESC LIMIT 20'
    ).bind(account.account_id).all();
    return json({
      ok: true,
      username: account.username,
      connected: Boolean(account.payload_enc),
      listener: listenerStatus,
      settings: {
        current_amount: Number(account.current_amount),
        goal_amount: Number(account.goal_amount),
        currency: String(account.currency || 'RUB')
      },
      widget_url: widgetUrl(env, widgetKey),
      donations: donations.results || []
    });
  }

  if (path === '/api/settings' && request.method === 'POST') {
    const account = await accountFromSession(request, env);
    if (!account) return json({ ok: false, error: 'Сессия завершилась. Подключи DonationAlerts заново.' }, 401);
    const amounts = validateAmounts(await readJson(request));
    if (amounts.error) return json({ ok: false, error: amounts.error }, 400);
    await env.DB.prepare(
      'UPDATE accounts SET current_amount=?,goal_amount=?,currency=?,updated_at=? WHERE account_id=?'
    ).bind(amounts.current, amounts.goal, amounts.currency, new Date().toISOString(), account.account_id).run();
    await listenerCommand(env, account.account_id, '/broadcast-state');
    return json({ ok: true, settings: amounts });
  }

  if (path === '/api/widget/rotate' && request.method === 'POST') {
    const account = await accountFromSession(request, env);
    if (!account) return json({ ok: false, error: 'Сессия завершилась.' }, 401);
    const widgetKey = randomHex(32);
    const hash = await sha256Hex(widgetKey);
    const encrypted = await encryptJson(env, widgetKey);
    await env.DB.prepare(
      'UPDATE accounts SET widget_key_hash=?,widget_key_enc=?,updated_at=? WHERE account_id=?'
    ).bind(hash, encrypted, new Date().toISOString(), account.account_id).run();
    return json({ ok: true, widget_url: widgetUrl(env, widgetKey) });
  }

  if (path === '/api/admin/donations' && request.method === 'GET') {
    const account = await accountFromSession(request, env);
    if (!account) return json({ ok: false, error: 'Сессия завершилась.' }, 401);
    const rows = await env.DB.prepare(
      'SELECT donation_id AS id,username,amount,currency,message,created_at,counted FROM donations ' +
      'WHERE account_id=? ORDER BY created_at DESC LIMIT 50'
    ).bind(account.account_id).all();
    return json({ ok: true, donations: rows.results || [] });
  }

  if (path === '/api/listener/restart' && request.method === 'POST') {
    const account = await accountFromSession(request, env);
    if (!account) return json({ ok: false, error: 'Сессия завершилась.' }, 401);
    const response = await listenerCommand(env, account.account_id, '/start');
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return json({ ok: false, error: result.error || 'Не удалось запустить приём донатов.' }, 502);
    return json({ ok: true, listener: result });
  }

  if (path === '/api/disconnect' && request.method === 'POST') {
    const account = await accountFromSession(request, env);
    if (!account) return json({ ok: false, error: 'Сессия завершилась.' }, 401);
    await env.DB.prepare(
      'UPDATE accounts SET payload_enc=NULL,token_expires_at=0,updated_at=? WHERE account_id=?'
    ).bind(new Date().toISOString(), account.account_id).run();
    await listenerCommand(env, account.account_id, '/stop');
    return json({ ok: true });
  }

  if (path === '/api/logout' && request.method === 'POST') {
    const token = authToken(request);
    if (token) {
      const hash = await sha256Hex(token);
      await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(hash).run();
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: 'Маршрут не найден.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (request.method === 'OPTIONS') {
        if (!originAllowed(request, env)) return json({ ok: false, error: 'Origin не разрешён.' }, 403);
        return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      }
      if (path === '/oauth/callback') return await api(request, env);
      if (!originAllowed(request, env)) return json({ ok: false, error: 'Origin не разрешён.' }, 403);

      if (path === '/live') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return withCors(json({ ok: false, error: 'Для live-канала нужен WebSocket.' }, 426), request, env);
        }
        const url = new URL(request.url);
        const account = await accountFromWidgetKey(url.searchParams.get('key') || '', env);
        if (!account) return new Response('Invalid widget key', { status: 404 });
        return listener(env, account.account_id).fetch(request, {
          headers: {
            'x-tears-internal': env.INTERNAL_SECRET || '',
            'x-account-id': account.account_id
          }
        });
      }

      return withCors(await api(request, env), request, env);
    } catch (error) {
      console.error('Worker request failed:', error && error.message || error);
      return withCors(json({ ok: false, error: 'Внутренняя ошибка Worker. Проверь Worker Logs.' }, 500), request, env);
    }
  }
};

export class DonationAlertsListener extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.daSocket = null;
    this.connectPromise = null;
    this.clientId = null;
    this.subscribePending = false;
    this.retryCount = 0;
    this.messageQueue = Promise.resolve();
    this.accountId = '';
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/live') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      if (request.headers.get('x-tears-internal') !== this.env.INTERNAL_SECRET) return new Response('Forbidden', { status: 403 });
      this.accountId = request.headers.get('x-account-id') || this.accountId;
      if (!this.accountId) return new Response('Missing account', { status: 400 });
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server, ['viewers']);
      server.serializeAttachment({ role: 'viewer', connectedAt: Date.now() });
      await this.sendCurrentState(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.headers.get('x-tears-internal') !== this.env.INTERNAL_SECRET) {
      return new Response('Forbidden', { status: 403 });
    }
    this.accountId = request.headers.get('x-account-id') || this.accountId;
    if (!this.accountId) return new Response('Missing account', { status: 400 });

    if (url.pathname === '/start') {
      await this.ctx.storage.put('listener_enabled', true);
      await this.ctx.storage.put('account_id', this.accountId);
      await this.ctx.storage.put('listener_state', 'connecting');
      await this.ctx.storage.delete('last_error');
      await this.connectDonationAlerts(false);
      const listenerState = await this.ctx.storage.get('listener_state');
      const lastError = await this.ctx.storage.get('last_error');
      return Response.json({
        ok: listenerState !== 'error',
        state: listenerState || 'connecting',
        last_error: lastError || ''
      });
    }
    if (url.pathname === '/stop') {
      await this.ctx.storage.put('listener_enabled', false);
      await this.ctx.storage.deleteAlarm();
      this.closeDonationSocket();
      await this.ctx.storage.put('listener_state', 'stopped');
      return Response.json({ ok: true });
    }
    if (url.pathname === '/broadcast-state') {
      await this.broadcastState();
      return Response.json({ ok: true });
    }
    if (url.pathname === '/status') {
      const listenerState = await this.ctx.storage.get('listener_state');
      const lastError = await this.ctx.storage.get('last_error');
      const lastConnectedAt = await this.ctx.storage.get('last_connected_at');
      const lastMessageAt = await this.ctx.storage.get('last_message_at');
      const lastDonationAt = await this.ctx.storage.get('last_donation_at');
      return Response.json({
        state: listenerState || 'not-started',
        last_error: lastError || '',
        last_connected_at: lastConnectedAt || '',
        last_message_at: lastMessageAt || '',
        last_donation_at: lastDonationAt || ''
      });
    }
    return new Response('Not found', { status: 404 });
  }

  async sendCurrentState(socket) {
    const accountId = this.accountId || await this.ctx.storage.get('account_id');
    const account = await this.env.DB.prepare(
      'SELECT current_amount,goal_amount,currency FROM accounts WHERE account_id=?'
    ).bind(accountId).first();
    socket.send(JSON.stringify({
      type: 'state',
      state: {
        current_amount: Number(account && account.current_amount || 0),
        goal_amount: Number(account && account.goal_amount || 10000),
        currency: String(account && account.currency || 'RUB')
      }
    }));
  }

  async alarm() {
    if (await this.ctx.storage.get('listener_enabled')) {
      await this.connectDonationAlerts(false);
    }
  }

  webSocketMessage(socket, message) {
    if (typeof message === 'string' && message === 'ping') {
      try { socket.send('pong'); } catch (_) {}
    }
  }
  webSocketClose(socket, code, reason) {
    try { socket.close(code, reason); } catch (_) {}
  }

  closeDonationSocket() {
    if (this.daSocket) {
      try { this.daSocket.close(1000, 'listener restart'); } catch (_) {}
    }
    this.daSocket = null;
    this.clientId = null;
    this.subscribePending = false;
  }

  async scheduleRetry() {
    if (!(await this.ctx.storage.get('listener_enabled'))) return;
    this.retryCount = Math.min(this.retryCount + 1, 8);
    const delay = Math.min(60000, 2500 * Math.pow(1.7, this.retryCount));
    await this.ctx.storage.put('listener_state', 'reconnecting');
    await this.ctx.storage.setAlarm(Date.now() + delay);
  }

  async connectDonationAlerts(forceRefresh) {
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = this.openDonationAlerts(forceRefresh)
      .catch(async error => {
        const message = String(error && error.message || error);
        await this.ctx.storage.put('listener_state', 'error');
        await this.ctx.storage.put('last_error', message.slice(0, 300));
        console.error('DonationAlerts listener:', message);
        await this.scheduleRetry();
      })
      .finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }

  async openDonationAlerts(forceRefresh) {
    const accountId = this.accountId || await this.ctx.storage.get('account_id');
    if (!(await this.ctx.storage.get('listener_enabled'))) return;
    if (!accountId) throw new Error('Не найден ID аккаунта стримера.');
    this.accountId = accountId;
    this.closeDonationSocket();
    await this.ctx.storage.put('listener_state', 'connecting');
    await this.ctx.storage.delete('last_error');

    let saved = await readAccountTokens(accountId, this.env);
    if (!saved || !saved.refresh_token) throw new Error('Нет Refresh Token. Стримеру нужно заново подключить DonationAlerts.');
    if (forceRefresh || Number(saved.expires_at || 0) < Date.now() + 180000) {
      const refreshed = await daFetch(DA_OAUTH + '/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: saved.refresh_token,
          client_id: this.env.DA_CLIENT_ID,
          client_secret: this.env.DA_CLIENT_SECRET,
          scope: OAUTH_SCOPES
        })
      });
      saved.access_token = refreshed.access_token;
      if (refreshed.refresh_token) saved.refresh_token = refreshed.refresh_token;
      saved.expires_at = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
      await writeAccountTokens(accountId, saved, this.env);
    }

    const profileResponse = await daFetch(DA_API + '/user/oauth', {
      headers: { Authorization: 'Bearer ' + saved.access_token, Accept: 'application/json' }
    });
    const profile = profileResponse.data || {};
    if (!profile.id || !profile.socket_connection_token) throw new Error('DonationAlerts не вернул socket_connection_token.');

    const socket = new WebSocket(DA_WS);
    this.daSocket = socket;
    this.clientId = null;
    this.subscribePending = false;

    socket.addEventListener('open', () => {
      try {
        socket.send(JSON.stringify({ params: { token: profile.socket_connection_token }, id: 1 }));
        this.ctx.storage.put('listener_state', 'connecting').catch(() => {});
        this.ctx.storage.setAlarm(Date.now() + 12 * 60 * 1000).catch(() => {});
      } catch (_) {
        this.scheduleRetry().catch(() => {});
      }
    });

    socket.addEventListener('message', event => {
      this.messageQueue = this.messageQueue.then(() => this.handleCentrifugoMessage(event.data))
        .catch(async error => {
          await this.ctx.storage.put('last_error', String(error && error.message || error).slice(0, 300));
          this.closeDonationSocket();
          await this.scheduleRetry();
        });
    });
    socket.addEventListener('error', () => {
      this.ctx.storage.put('last_error', 'WebSocket DonationAlerts: ошибка соединения.').catch(() => {});
    });
    socket.addEventListener('close', () => {
      if (this.daSocket !== socket) return;
      this.daSocket = null;
      this.clientId = null;
      this.scheduleRetry().catch(() => {});
    });
  }

  async handleCentrifugoMessage(raw) {
    const messages = String(raw || '').split(/\r?\n/).filter(Boolean);
    for (const chunk of messages) {
      let message;
      try { message = JSON.parse(chunk); } catch (_) { continue; }

      const now = new Date().toISOString();
      await this.ctx.storage.put('last_message_at', now);

      // Initial Centrifugo connection acknowledgement: contains the assigned client UUID.
      if (message && message.result && message.result.client && !this.subscribePending) {
        this.clientId = String(message.result.client);
        this.subscribePending = true;
        await this.subscribeToDonations();
        continue;
      }

      // DonationAlerts' documented private-channel acknowledgement may not echo request id=2.
      const ackChannel = String(message && message.result && message.result.channel || '');
      if (
        message && message.result &&
        (message.id === 2 || (message.result.type === 1 && ackChannel.startsWith('$alerts:donation_')))
      ) {
        this.retryCount = 0;
        await this.ctx.storage.put('listener_state', 'connected');
        await this.ctx.storage.put('last_connected_at', now);
        await this.ctx.storage.delete('last_error');
        this.broadcast({ type: 'status', state: 'connected', message: 'DonationAlerts подключён.' });
        // A normal subscription acknowledgement contains result.data.info, not a donation.
        if (message.result.type === 1 && message.result.data && message.result.data.info) continue;
      }

      // DonationAlerts publishes the donation resource in result.data.data.
      // Other Centrifugo/proxy envelopes can wrap it in pub.data or push.pub.data.
      const publicationChannel = String(
        message && message.result && message.result.channel ||
        message && message.push && message.push.channel ||
        message && message.channel || ''
      );
      const publication =
        message && message.push && message.push.pub && message.push.pub.data ||
        message && message.result && message.result.pub && message.result.pub.data ||
        message && message.pub && message.pub.data ||
        (publicationChannel.startsWith('$alerts:donation_') ? message : null);
      const donation = this.extractDonation(publication);
      if (donation) await this.recordDonation(donation);

      if (message && (message.disconnect || message.refresh || message.push && (message.push.disconnect || message.push.refresh))) {
        this.closeDonationSocket();
        await this.scheduleRetry();
      }
    }
  }

  extractDonation(value) {
    const queue = [{ value, depth: 0 }];
    const visited = new Set();
    while (queue.length) {
      const entry = queue.shift();
      const item = entry && entry.value;
      if (!item || typeof item !== 'object' || visited.has(item) || entry.depth > 8) continue;
      visited.add(item);

      if (
        item.id != null &&
        item.amount != null &&
        item.currency != null &&
        Number.isFinite(Number(item.amount))
      ) {
        return item;
      }

      if (Array.isArray(item)) {
        for (const child of item) {
          if (child && typeof child === 'object') queue.push({ value: child, depth: entry.depth + 1 });
        }
      } else {
        for (const child of Object.values(item)) {
          if (child && typeof child === 'object') queue.push({ value: child, depth: entry.depth + 1 });
        }
      }
    }
    return null;
  }

  async subscribeToDonations() {
    const accountId = this.accountId || await this.ctx.storage.get('account_id');
    const saved = await readAccountTokens(accountId, this.env);
    if (!saved || !saved.access_token || !saved.user_id || !this.clientId) {
      throw new Error('Не хватает данных для подписки Centrifugo.');
    }
    const channel = '$alerts:donation_' + saved.user_id;
    const response = await daFetch(DA_API + '/centrifuge/subscribe', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + saved.access_token,
        'content-type': 'application/json',
        Accept: 'application/json'
      },
      body: JSON.stringify({ channels: [channel], client: this.clientId })
    });
    const channels = response.channels || (response.data && response.data.channels) || [];
    const subscription = channels.find(item => item.channel === channel && item.token);
    if (!subscription) throw new Error('DonationAlerts не вернул token подписки.');
    this.daSocket.send(JSON.stringify({
      params: { channel, token: subscription.token },
      method: 1,
      id: 2
    }));
    await this.ctx.storage.put('listener_state', 'subscribing');
  }

  async recordDonation(item) {
    const accountId = this.accountId || await this.ctx.storage.get('account_id');
    const id = String(item.id == null ? '' : item.id).trim();
    const amount = Number(item.amount);
    const currency = String(item.currency || '').toUpperCase();
    const username = String(item.username || item.name || 'Аноним').slice(0, 80);
    const message = String(item.message || '').slice(0, 500);
    if (!accountId || !id || id.length > 100 || !Number.isFinite(amount) || amount <= 0 || amount > 1e9 || !currency) return;

    const account = await this.env.DB.prepare('SELECT currency FROM accounts WHERE account_id=?')
      .bind(accountId).first();
    const counted = currency === String(account && account.currency || 'RUB') ? 1 : 0;
    const createdAt = String(item.created_at || new Date().toISOString());
    const inserted = await this.env.DB.prepare(
      'INSERT OR IGNORE INTO donations (account_id,donation_id,username,amount,currency,message,created_at,counted) VALUES (?,?,?,?,?,?,?,?)'
    ).bind(accountId, id, username, amount, currency, message, createdAt, counted).run();

    if (!inserted || !inserted.meta || !inserted.meta.changes) return;
    if (!counted) {
      this.broadcast({
        type: 'status',
        state: 'currency-mismatch',
        message: 'Донат пропущен: валюта ' + currency + ', в сборе выбрана ' + String(account && account.currency || 'RUB') + '.'
      });
      return;
    }

    await this.env.DB.prepare('UPDATE accounts SET current_amount=current_amount+?,updated_at=? WHERE account_id=?')
      .bind(amount, new Date().toISOString(), accountId).run();
    const updated = await this.env.DB.prepare(
      'SELECT current_amount,goal_amount,currency FROM accounts WHERE account_id=?'
    ).bind(accountId).first();

    this.broadcast({
      type: 'donation',
      id,
      username,
      amount,
      currency,
      message,
      current_amount: Number(updated.current_amount),
      goal_amount: Number(updated.goal_amount)
    });
    await this.ctx.storage.put('last_donation_at', new Date().toISOString());
  }

  broadcast(data) {
    const frame = JSON.stringify(data);
    for (const socket of this.ctx.getWebSockets('viewers')) {
      try { socket.send(frame); } catch (_) { try { socket.close(1011, 'send failed'); } catch (_) {} }
    }
  }

  async broadcastState() {
    const accountId = this.accountId || await this.ctx.storage.get('account_id');
    const account = await this.env.DB.prepare(
      'SELECT current_amount,goal_amount,currency FROM accounts WHERE account_id=?'
    ).bind(accountId).first();
    this.broadcast({
      type: 'state',
      state: {
        current_amount: Number(account && account.current_amount || 0),
        goal_amount: Number(account && account.goal_amount || 10000),
        currency: String(account && account.currency || 'RUB')
      }
    });
  }
}
