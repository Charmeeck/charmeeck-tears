'use strict';
(() => {
  let workerBase = String(window.TEARS_DA_WORKER || '');
  while (workerBase.endsWith('/')) workerBase = workerBase.slice(0, -1);
  const params = new URLSearchParams(window.location.search);
  const widgetKey = String(params.get('key') || '').trim();

  if (!widgetKey) {
    console.warn('[Tears] В ссылке OBS отсутствует персональный ключ виджета.');
    return;
  }
  if (!workerBase || workerBase.includes('REPLACE-WITH-YOUR-WORKER')) {
    console.warn('[Tears] Не настроен адрес Cloudflare Worker в config.js.');
    return;
  }

  let socket = null;
  let retryTimer = null;
  let retryCount = 0;
  let stopped = false;

  async function loadState() {
    const response = await fetch(
      workerBase + '/api/state?key=' + encodeURIComponent(widgetKey),
      { cache: 'no-store' }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data.error || ('Не удалось загрузить состояние: HTTP ' + response.status));
    }
    return data;
  }

  function applyState(state) {
    if (!state || !window.TearsWidget || typeof window.TearsWidget.setBaseline !== 'function') return;
    window.TearsWidget.setBaseline({
      current_amount: Number(state.current_amount || 0),
      goal_amount: Number(state.goal_amount || 1),
      currency: String(state.currency || 'RUB')
    });
  }

  function connect() {
    if (stopped || socket) return;
    const wsBase = workerBase.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');
    const url = wsBase + '/live?key=' + encodeURIComponent(widgetKey);
    const ws = new WebSocket(url);
    socket = ws;

    ws.addEventListener('open', () => {
      retryCount = 0;
      console.info('[Tears] Live-подключение активно.');
    });

    ws.addEventListener('message', event => {
      let data;
      try { data = JSON.parse(event.data); } catch (_) { return; }
      if (data.type === 'state') {
        applyState(data.state);
        return;
      }
      if (data.type === 'donation') {
        if (window.TearsWidget && typeof window.TearsWidget.triggerDonation === 'function') {
          window.TearsWidget.triggerDonation(
            Number(data.amount),
            String(data.username || 'Аноним'),
            'donationalerts:' + String(data.id)
          );
        } else if (data.current_amount != null) {
          applyState({
            current_amount: data.current_amount,
            goal_amount: data.goal_amount,
            currency: data.currency
          });
        }
        return;
      }
      if (data.type === 'status' && data.state === 'currency-mismatch') {
        console.warn('[Tears] ' + String(data.message || 'Донат в другой валюте не засчитан.'));
      }
    });

    ws.addEventListener('close', () => {
      if (socket === ws) socket = null;
      scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      try { ws.close(); } catch (_) {}
    });
  }

  function scheduleReconnect() {
    if (stopped || retryTimer) return;
    const delay = Math.min(30000, 1200 * Math.pow(1.7, retryCount));
    retryCount = Math.min(retryCount + 1, 8);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, delay);
  }

  loadState()
    .then(state => {
      applyState(state);
      connect();
    })
    .catch(error => {
      console.error('[Tears]', error.message);
      scheduleReconnect();
    });

  window.addEventListener('beforeunload', () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    try { if (socket) socket.close(); } catch (_) {}
  });
})();
