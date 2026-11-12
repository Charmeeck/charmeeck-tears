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
  let pollTimer = null;
  let pollInFlight = false;
  let lastRealtimeAt = 0;

  // Резервная сверка с сервером: помогает OBS восстановить сумму,
  // даже если WebSocket временно потерял событие или переподключается.
  function applyServerState(state, source, requestStartedAt = 0) {
    if (!state || !window.TearsWidget || typeof window.TearsWidget.getState !== 'function') return;
    const serverCurrent = Number(state.current_amount);
    const serverGoal = Number(state.goal_amount);
    const local = window.TearsWidget.getState();
    const localCurrent = Number(local.current);

    if (!Number.isFinite(serverCurrent) || serverCurrent < 0) return;

    // Не откатываем сумму ответом старого poll-запроса, если после его
    // отправки уже пришло более новое событие по WebSocket.
    const realtimeArrivedDuringPoll =
      source === 'poll' && requestStartedAt > 0 && lastRealtimeAt > requestStartedAt;

    if (serverCurrent > localCurrent + 0.000001) {
      const difference = serverCurrent - localCurrent;
      window.TearsWidget.triggerDonation(
        difference,
        source === 'poll' ? 'DonationAlerts · синхронизация' : 'DonationAlerts',
        'server-total:' + String(serverCurrent)
      );
    } else if (serverCurrent < localCurrent - 0.000001 && !realtimeArrivedDuringPoll) {
      // Сброс/ручная корректировка суммы в панели администратора.
      window.TearsWidget.setBaseline({
        current_amount: serverCurrent,
        goal_amount: Number.isFinite(serverGoal) && serverGoal > 0 ? serverGoal : local.goal,
        currency: state.currency || local.currency
      });
      return;
    }

    // Цель и валюта тоже могут быть изменены в панели.
    const currentAfterSync = window.TearsWidget.getState().current;
    window.TearsWidget.setBaseline({
      current_amount: currentAfterSync,
      goal_amount: Number.isFinite(serverGoal) && serverGoal > 0 ? serverGoal : local.goal,
      currency: state.currency || local.currency
    });
  }

  async function pollState() {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    const requestStartedAt = Date.now();
    try {
      const state = await loadState();
      applyServerState(state, 'poll', requestStartedAt);
    } catch (error) {
      console.warn('[Tears] Резервная синхронизация не удалась:', error.message);
    } finally {
      pollInFlight = false;
    }
  }

  function startPolling() {
    if (pollTimer || stopped) return;
    pollState();
    pollTimer = setInterval(pollState, 5000);
  }

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
        applyServerState(data.state, 'websocket');
        lastRealtimeAt = Date.now();
        return;
      }
      if (data.type === 'donation') {
        lastRealtimeAt = Date.now();
        if (data.current_amount != null) {
          // Сверяем абсолютную сумму, а не прибавляем событие вслепую:
          // это защищает от двойного начисления при гонке WebSocket и poll.
          applyServerState({
            current_amount: data.current_amount,
            goal_amount: data.goal_amount,
            currency: data.currency
          }, 'websocket');
        } else if (window.TearsWidget && typeof window.TearsWidget.triggerDonation === 'function') {
          window.TearsWidget.triggerDonation(
            Number(data.amount),
            String(data.username || 'Аноним'),
            'donationalerts:' + String(data.id)
          );
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
      startPolling();
    })
    .catch(error => {
      console.error('[Tears]', error.message);
      scheduleReconnect();
      startPolling();
    });

  window.addEventListener('beforeunload', () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    if (pollTimer) clearInterval(pollTimer);
    try { if (socket) socket.close(); } catch (_) {}
  });
})();
