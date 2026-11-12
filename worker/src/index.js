import { DurableObject } from 'cloudflare:workers';

const DA_API = 'https://www.donationalerts.com/api/v1';
const DA_OAUTH = 'https://www.donationalerts.com/oauth';
const DA_WS = 'wss://centrifugo.donationalerts.com/connection/websocket';
const SCOPES = 'oauth-user-show oauth-donation-subscribe';
const CURRENCIES = new Set(['RUB','USD','EUR','KZT','UAH','BYN','BRL','TRY']);

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }, headers || {})
  });
}
function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const h = new Headers({
    'Vary': 'Origin',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '86400'
  });
  if (origin && origin === env.ALLOWED_ORIGIN) h.set('Access-Control-Allow-Origin', origin);
  return h;
}
function withCors(response, request, env) {
  const h = new Headers(response.headers);
  for (const pair of corsHeaders(request, env)) h.set(pair[0], pair[1]);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: h });
}
function allowed(request, env) {
  const origin = request.headers.get('Origin');
  return !origin || origin === env.ALLOWED_ORIGIN;
}
function safeEqual(a, b) {
  const aa = new TextEncoder().encode(String(a || ''));
  const bb = new TextEncoder().encode(String(b || ''));
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) diff |= (aa[i] || 0) ^ (bb[i] || 0);
  return diff === 0;
}
function adminDenied(request, env) {
  const m = String(request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  return m && env.ADMIN_PASSWORD && safeEqual(m[1], env.ADMIN_PASSWORD)
    ? null : json({ ok: false, error: 'Нужен пароль администратора.' }, 401);
}
function randomHex(bytes) {
  const a = crypto.getRandomValues(new Uint8Array(bytes || 32));
  return Array.from(a).map(x => x.toString(16).padStart(2, '0')).join('');
}
function b64(a) {
  let s = '';
  for (const x of a) s += String.fromCharCode(x);
  return btoa(s);
}
function unb64(s) {
  const bin = atob(s);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}
async function encryptionKey(env) {
  if (!env.APP_ENCRYPTION_KEY) throw new Error('Не задан APP_ENCRYPTION_KEY.');
  const raw = unb64(env.APP_ENCRYPTION_KEY.trim());
  if (raw.length !== 32) throw new Error('APP_ENCRYPTION_KEY должен быть Base64 от 32 случайных байт.');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt','decrypt']);
}
async function encrypt(env, value) {
  const key = await encryptionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = new TextEncoder().encode(JSON.stringify(value));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, plain);
  const out = new Uint8Array(iv.length + cipher.byteLength);
  out.set(iv, 0); out.set(new Uint8Array(cipher), iv.length);
  return b64(out);
}
async function decrypt(env, value) {
  const key = await encryptionKey(env);
  const bytes = unb64(value);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0,12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}
async function bodyJson(request) {
  try { return await request.json(); } catch (_) { return {}; }
}
async function daFetch(url, options) {
  const response = await fetch(url, options || {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error('DonationAlerts: ' + (data.message || data.error_description || ('HTTP ' + response.status)));
  }
  return data;
}
async function settings(env) {
  return env.DB.prepare('SELECT current_amount, goal_amount, currency, updated_at FROM settings WHERE id = 1').first();
}
async function tokens(env) {
  const row = await env.DB.prepare('SELECT payload_enc FROM oauth_tokens WHERE id = 1').first();
  return row && row.payload_enc ? decrypt(env, row.payload_enc) : null;
}
async function saveTokens(env, value) {
  const encrypted = await encrypt(env, value);
  await env.DB.prepare(
    'INSERT INTO oauth_tokens (id,payload_enc,expires_at,user_id,username,connected_at) VALUES (1,?,?,?,?,?) ' +
    'ON CONFLICT(id) DO UPDATE SET payload_enc=excluded.payload_enc,expires_at=excluded.expires_at,user_id=excluded.user_id,username=excluded.username,connected_at=excluded.connected_at'
  ).bind(encrypted, Number(value.expires_at || 0), String(value.user_id || ''), String(value.username || ''), new Date().toISOString()).run();
}
function listener(env) {
  return env.LISTENER.get(env.LISTENER.idFromName('primary'));
}
async function tellListener(env, path) {
  return listener(env).fetch('https://listener.internal' + path, {
    method: 'POST', headers: { 'x-tears-internal': env.INTERNAL_SECRET || '' }
  });
}
function workerBase(env) {
  return String(env.WORKER_BASE_URL || '').replace(/\/+$/, '');
}
async function api(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (path === '/health') return json({ ok: true, service: 'Tears DonationAlerts Worker', version: '1.0' });
  if (path === '/api/state' && request.method === 'GET') {
    const s = await settings(env);
    if (!s) return json({ ok: false, error: 'Сначала примени миграцию базы данных.' }, 503);
    return json({
      current_amount: Number(s.current_amount), goal_amount: Number(s.goal_amount),
      currency: s.currency, updated_at: s.updated_at
    });
  }

  if (path === '/api/admin/status' && request.method === 'GET') {
    const denied = adminDenied(request, env); if (denied) return denied;
    const s = await settings(env);
    const account = await env.DB.prepare('SELECT username,user_id,connected_at FROM oauth_tokens WHERE id=1').first();
    const response = await listener(env).fetch('https://listener.internal/status', { headers: { 'x-tears-internal': env.INTERNAL_SECRET || '' } });
    const status = await response.json().catch(() => ({}));
    return json({ ok: true, settings: s, connected: Boolean(account && account.user_id),
      streamer_name: account && account.username || '', listener: status });
  }

  if (path === '/api/admin/connect-url' && request.method === 'POST') {
    const denied = adminDenied(request, env); if (denied) return denied;
    if (!env.DA_CLIENT_ID || !env.DA_CLIENT_SECRET) {
      return json({ ok: false, error: 'Добавь DA_CLIENT_ID и DA_CLIENT_SECRET в Cloudflare Worker.' }, 503);
    }
    await env.DB.prepare('DELETE FROM oauth_state WHERE expires_at < ?').bind(Date.now()).run();
    const state = randomHex(32);
    await env.DB.prepare('INSERT INTO oauth_state (state,expires_at) VALUES (?,?)')
      .bind(state, Date.now() + 10 * 60 * 1000).run();
    const params = new URLSearchParams({
      client_id: env.DA_CLIENT_ID,
      redirect_uri: workerBase(env) + '/oauth/callback',
      response_type: 'code', scope: SCOPES, state: state
    });
    return json({ ok: true, authorize_url: DA_OAUTH + '/authorize?' + params.toString() });
  }

  if (path === '/api/admin/settings' && request.method === 'POST') {
    const denied = adminDenied(request, env); if (denied) return denied;
    const b = await bodyJson(request);
    const current = Number(b.current_amount), goal = Number(b.goal_amount);
    const currency = String(b.currency || 'RUB').toUpperCase();
    if (!Number.isFinite(current) || current < 0 || !Number.isFinite(goal) || goal <= 0 || !CURRENCIES.has(currency)) {
      return json({ ok: false, error: 'Проверь текущую сумму, цель и валюту.' }, 400);
    }
    await env.DB.prepare('UPDATE settings SET current_amount=?,goal_amount=?,currency=?,updated_at=? WHERE id=1')
      .bind(current, goal, currency, new Date().toISOString()).run();
    await tellListener(env, '/broadcast-state');
    return json({ ok: true, settings: await settings(env) });
  }

  if (path === '/api/admin/donations' && request.method === 'GET') {
    const denied = adminDenied(request, env); if (denied) return denied;
    const rows = await env.DB.prepare(
      'SELECT id,username,amount,currency,message,created_at,counted FROM donations ORDER BY created_at DESC LIMIT 30'
    ).all();
    return json({ ok: true, donations: rows.results || [] });
  }

  if (path === '/api/admin/disconnect' && request.method === 'POST') {
    const denied = adminDenied(request, env); if (denied) return denied;
    await env.DB.prepare('DELETE FROM oauth_tokens WHERE id=1').run();
    await tellListener(env, '/stop');
    return json({ ok: true });
  }

  if (path === '/oauth/callback' && request.method === 'GET') {
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const oauthError = url.searchParams.get('error');
    if (oauthError) return new Response('DonationAlerts отменил доступ: ' + oauthError, { status: 400 });
    if (!code || !state) return new Response('Не получен код или state от DonationAlerts.', { status: 400 });
    const saved = await env.DB.prepare('SELECT expires_at FROM oauth_state WHERE state=?').bind(state).first();
    await env.DB.prepare('DELETE FROM oauth_state WHERE state=?').bind(state).run();
    if (!saved || Number(saved.expires_at) < Date.now()) {
      return new Response('OAuth state истёк или уже использован. Вернись в панель и начни подключение заново.', { status: 400 });
    }
    try {
      const tokenData = await daFetch(DA_OAUTH + '/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: env.DA_CLIENT_ID,
          client_secret: env.DA_CLIENT_SECRET, redirect_uri: workerBase(env) + '/oauth/callback', code: code
        })
      });
      if (!tokenData.access_token || !tokenData.refresh_token) throw new Error('DonationAlerts не вернул OAuth-токены.');
      const profileData = await daFetch(DA_API + '/user/oauth', {
        headers: { Authorization: 'Bearer ' + tokenData.access_token, Accept: 'application/json' }
      });
      const profile = profileData.data || {};
      if (!profile.id || !profile.socket_connection_token) {
        throw new Error('Не получен профиль DonationAlerts. Проверь разрешения oauth-user-show и oauth-donation-subscribe.');
      }
      await saveTokens(env, {
        access_token: tokenData.access_token, refresh_token: tokenData.refresh_token,
        expires_at: Date.now() + Number(tokenData.expires_in || 3600) * 1000,
        user_id: String(profile.id), username: String(profile.name || profile.code || 'DonationAlerts')
      });
      const started = await tellListener(env, '/start');
      if (!started.ok) throw new Error('OAuth выполнен, но не удалось запустить приём донатов.');
      return Response.redirect(String(env.ADMIN_PAGE_URL || '') + '?connected=1', 302);
    } catch (error) {
      console.error('OAuth callback failed:', error && error.message || error);
      return new Response('Не удалось подключить DonationAlerts. Проверь Client ID/Secret и разрешения OAuth. Деталь: ' +
        String(error && error.message || 'unknown').slice(0, 240), { status: 502 });
    }
  }
  return json({ ok: false, error: 'Маршрут не найден.' }, 404);
}

export default {
  async fetch(request, env) {
    try {
      const path = new URL(request.url).pathname;
      if (path === '/oauth/callback') return await api(request, env);
      if (!allowed(request, env)) return json({ ok: false, error: 'Origin не разрешён.' }, 403);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(request, env) });
      if (path === '/live') {
        if (request.headers.get('Upgrade') !== 'websocket') {
          return withCors(json({ ok: false, error: 'Для live-канала нужен WebSocket.' }, 426), request, env);
        }
        return listener(env).fetch(request);
      }
      return withCors(await api(request, env), request, env);
    } catch (error) {
      console.error('Worker request failed:', error && error.message || error);
      return withCors(json({ ok: false, error: 'Внутренняя ошибка Worker. Проверь Logs в Cloudflare.' }, 500), request, env);
    }
  }
};

export class DonationAlertsListener extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx; this.env = env; this.daSocket = null;
    this.connectPromise = null; this.clientId = null; this.subscribePending = false;
    this.retryCount = 0; this.queue = Promise.resolve();
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/live') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const pair = new WebSocketPair();
      const client = pair[0], server = pair[1];
      this.ctx.acceptWebSocket(server, ['viewers']);
      server.serializeAttachment({ role: 'viewer', connectedAt: Date.now() });
      const s = await settings(this.env);
      server.send(JSON.stringify({ type: 'state', state: {
        current_amount: Number(s && s.current_amount || 0),
        goal_amount: Number(s && s.goal_amount || 10000),
        currency: String(s && s.currency || 'RUB')
      }}));
      return new Response(null, { status: 101, webSocket: client });
    }
    if (request.headers.get('x-tears-internal') !== this.env.INTERNAL_SECRET) return new Response('Forbidden', { status: 403 });
    if (url.pathname === '/start') {
      await this.ctx.storage.put('listener_enabled', true);
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return Response.json({ ok: true });
    }
    if (url.pathname === '/stop') {
      await this.ctx.storage.put('listener_enabled', false);
      await this.ctx.storage.deleteAlarm();
      this.closeSocket();
      await this.ctx.storage.put('listener_state', 'stopped');
      return Response.json({ ok: true });
    }
    if (url.pathname === '/broadcast-state') {
      await this.broadcastState(); return Response.json({ ok: true });
    }
    if (url.pathname === '/status') {
      const v = await this.ctx.storage.get(['listener_state','last_error','last_connected_at']);
      return Response.json({ state: v.listener_state || 'not-started',
        last_error: v.last_error || '', last_connected_at: v.last_connected_at || '' });
    }
    return new Response('Not found', { status: 404 });
  }
  async alarm() {
    if (await this.ctx.storage.get('listener_enabled')) await this.connectDonationAlerts(false);
  }
  webSocketMessage(ws, message) {
    if (typeof message === 'string' && message === 'ping') { try { ws.send('pong'); } catch (_) {} }
  }
  webSocketClose(ws, code, reason) { try { ws.close(code, reason); } catch (_) {} }
  closeSocket() {
    if (this.daSocket) { try { this.daSocket.close(1000, 'listener restart'); } catch (_) {} }
    this.daSocket = null; this.clientId = null; this.subscribePending = false;
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
    this.connectPromise = this.openDonationAlerts(forceRefresh).catch(async error => {
      const message = String(error && error.message || error);
      await this.ctx.storage.put('listener_state', 'error');
      await this.ctx.storage.put('last_error', message.slice(0, 300));
      console.error('DonationAlerts listener:', message);
      await this.scheduleRetry();
    }).finally(() => { this.connectPromise = null; });
    return this.connectPromise;
  }
  async openDonationAlerts(forceRefresh) {
    if (!(await this.ctx.storage.get('listener_enabled'))) return;
    this.closeSocket();
    const saved = await tokens(this.env);
    if (!saved || !saved.refresh_token) throw new Error('Нет Refresh Token. Переподключи аккаунт в панели.');
    if (forceRefresh || Number(saved.expires_at || 0) < Date.now() + 180000) {
      const refreshed = await daFetch(DA_OAUTH + '/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json' },
        body: new URLSearchParams({
          grant_type: 'refresh_token', refresh_token: saved.refresh_token,
          client_id: this.env.DA_CLIENT_ID, client_secret: this.env.DA_CLIENT_SECRET, scope: SCOPES
        })
      });
      saved.access_token = refreshed.access_token;
      if (refreshed.refresh_token) saved.refresh_token = refreshed.refresh_token;
      saved.expires_at = Date.now() + Number(refreshed.expires_in || 3600) * 1000;
      await saveTokens(this.env, saved);
    }
    const p = await daFetch(DA_API + '/user/oauth', {
      headers: { Authorization: 'Bearer ' + saved.access_token, Accept: 'application/json' }
    });
    const profile = p.data || {};
    if (!profile.id || !profile.socket_connection_token) throw new Error('DonationAlerts не вернул socket_connection_token.');
    saved.user_id = String(profile.id);
    saved.username = String(profile.name || profile.code || saved.username || 'DonationAlerts');
    await saveTokens(this.env, saved);

    const ws = new WebSocket(DA_WS);
    this.daSocket = ws; this.clientId = null; this.subscribePending = false;
    ws.addEventListener('open', () => {
      try {
        ws.send(JSON.stringify({ params: { token: profile.socket_connection_token }, id: 1 }));
        this.ctx.storage.put('listener_state', 'connecting').catch(() => {});
        this.ctx.storage.setAlarm(Date.now() + 12 * 60 * 1000).catch(() => {});
      } catch (_) { this.scheduleRetry().catch(() => {}); }
    });
    ws.addEventListener('message', event => {
      this.queue = this.queue.then(() => this.handleMessage(event.data)).catch(async error => {
        await this.ctx.storage.put('last_error', String(error && error.message || error).slice(0, 300));
        this.closeSocket(); await this.scheduleRetry();
      });
    });
    ws.addEventListener('error', () => {
      this.ctx.storage.put('last_error', 'WebSocket DonationAlerts: ошибка соединения.').catch(() => {});
    });
    ws.addEventListener('close', () => {
      if (this.daSocket !== ws) return;
      this.daSocket = null; this.clientId = null; this.scheduleRetry().catch(() => {});
    });
  }
  async handleMessage(raw) {
    const chunks = String(raw || '').split(/\r?\n/).filter(Boolean);
    for (const chunk of chunks) {
      let msg; try { msg = JSON.parse(chunk); } catch (_) { continue; }
      if (msg && msg.result && msg.result.client && !this.subscribePending) {
        this.clientId = String(msg.result.client); this.subscribePending = true;
        await this.subscribeToDonations(); continue;
      }
      if (msg && msg.id === 2 && msg.result) {
        this.retryCount = 0;
        await this.ctx.storage.put('listener_state', 'connected');
        await this.ctx.storage.put('last_connected_at', new Date().toISOString());
        await this.ctx.storage.delete('last_error');
        this.broadcast({ type: 'status', state: 'connected', message: 'DonationAlerts подключён.' });
        continue;
      }
      const pub = msg && msg.push && msg.push.pub && msg.push.pub.data ||
        msg && msg.result && msg.result.pub && msg.result.pub.data ||
        msg && msg.pub && msg.pub.data;
      const donation = this.extractDonation(pub);
      if (donation) await this.recordDonation(donation);
      if (msg && (msg.disconnect || msg.refresh || msg.push && (msg.push.disconnect || msg.push.refresh))) {
        this.closeSocket(); await this.scheduleRetry();
      }
    }
  }
  extractDonation(value) {
    const q = [value], seen = new Set();
    while (q.length) {
      const item = q.shift();
      if (!item || typeof item !== 'object' || seen.has(item)) continue;
      seen.add(item);
      if (item.id != null && item.amount != null && item.currency != null) return item;
      if (item.data && typeof item.data === 'object') q.push(item.data);
      if (item.donation && typeof item.donation === 'object') q.push(item.donation);
    }
    return null;
  }
  async subscribeToDonations() {
    const saved = await tokens(this.env);
    if (!saved || !saved.access_token || !saved.user_id || !this.clientId) throw new Error('Не хватает данных для подписки Centrifugo.');
    const channel = '$alerts:donation_' + saved.user_id;
    const response = await daFetch(DA_API + '/centrifuge/subscribe', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + saved.access_token, 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ channels: [channel], client: this.clientId })
    });
    const subscription = (response.channels || []).find(x => x.channel === channel && x.token);
    if (!subscription) throw new Error('DonationAlerts не вернул token подписки.');
    this.daSocket.send(JSON.stringify({ params: { channel: channel, token: subscription.token }, method: 1, id: 2 }));
    await this.ctx.storage.put('listener_state', 'subscribing');
  }
  async recordDonation(item) {
    const id = String(item.id == null ? '' : item.id).trim();
    const amount = Number(item.amount), currency = String(item.currency || '').toUpperCase();
    const username = String(item.username || item.name || 'Аноним').slice(0, 80);
    const message = String(item.message || '').slice(0, 500);
    if (!id || id.length > 100 || !Number.isFinite(amount) || amount <= 0 || amount > 1e9 || !currency) return;
    const s = await settings(this.env);
    const counted = currency === String(s && s.currency || 'RUB') ? 1 : 0;
    const created = String(item.created_at || new Date().toISOString());
    const inserted = await this.env.DB.prepare(
      'INSERT OR IGNORE INTO donations (id,username,amount,currency,message,created_at,counted) VALUES (?,?,?,?,?,?,?)'
    ).bind(id, username, amount, currency, message, created, counted).run();
    if (!inserted || !inserted.meta || !inserted.meta.changes) return;
    if (!counted) {
      this.broadcast({ type: 'status', state: 'currency-mismatch',
        message: 'Донат пропущен: валюта ' + currency + ', в сборе выбрана ' + String(s && s.currency || 'RUB') + '.' });
      return;
    }
    await this.env.DB.prepare('UPDATE settings SET current_amount=current_amount+?,updated_at=? WHERE id=1')
      .bind(amount, new Date().toISOString()).run();
    const updated = await settings(this.env);
    this.broadcast({
      type: 'donation', id: id, username: username, amount: amount, currency: currency,
      message: message, current_amount: Number(updated.current_amount), goal_amount: Number(updated.goal_amount)
    });
    await this.ctx.storage.put('last_donation_at', new Date().toISOString());
  }
  broadcast(data) {
    const frame = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets('viewers')) {
      try { ws.send(frame); } catch (_) { try { ws.close(1011, 'send failed'); } catch (_) {} }
    }
  }
  async broadcastState() {
    const s = await settings(this.env);
    this.broadcast({ type: 'state', state: {
      current_amount: Number(s && s.current_amount || 0), goal_amount: Number(s && s.goal_amount || 10000),
      currency: String(s && s.currency || 'RUB')
    }});
  }
}
