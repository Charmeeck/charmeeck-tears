'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const currentLabel = $('currentLabel'), goalLabel = $('goalLabel');
  const waterRect = $('waterRect'), waterSurface = $('waterSurface');
  if (!currentLabel || !goalLabel || !waterRect || !waterSurface) return;
  const symbols = { RUB: '₽', USD: '$', EUR: '€', KZT: '₸', UAH: '₴', BYN: 'Br', BRL: 'R$', TRY: '₺' };
  let current = Number(currentLabel.textContent.replace(/[^0-9.,-]/g, '').replace(',', '.')) || 0;
  let goal = Number(goalLabel.textContent.replace(/[^0-9.,-]/g, '').replace(',', '.')) || 10000;
  let currency = 'RUB';
  const seen = new Set();
  const format = value => Math.round(value).toLocaleString('ru-RU') + ' ' + (symbols[currency] || currency);
  function render() {
    const pct = Math.max(0, Math.min(100, current / Math.max(1, goal) * 100));
    const level = 818 - (818 - 620) * pct / 100;
    waterRect.setAttribute('d', 'M748 ' + level.toFixed(1) + ' Q805 ' + (level - 6).toFixed(1) + ' 866 ' + level.toFixed(1) + ' Q927 ' + (level + 6).toFixed(1) + ' 984 ' + level.toFixed(1) + ' L984 840 L748 840 Z');
    waterSurface.setAttribute('d', 'M748 ' + level.toFixed(1) + ' Q805 ' + (level - 6).toFixed(1) + ' 866 ' + level.toFixed(1) + ' Q927 ' + (level + 6).toFixed(1) + ' 984 ' + level.toFixed(1));
    currentLabel.textContent = format(current);
    goalLabel.textContent = format(goal);
  }
  function toast(name, amount) {
    let node = $('tearsDonationToast');
    if (!node) {
      node = document.createElement('div');
      node.id = 'tearsDonationToast';
      node.style.cssText = 'position:absolute;left:50%;top:7%;transform:translate(-50%,-8px);z-index:20;padding:10px 18px;border:1px solid rgba(135,225,255,.65);border-radius:14px;background:rgba(4,22,43,.88);color:#f3fbff;font:600 clamp(14px,1.5vw,24px) Arial,sans-serif;text-align:center;box-shadow:0 0 24px rgba(40,190,255,.28);opacity:0;transition:opacity .25s,transform .25s;pointer-events:none;white-space:nowrap;max-width:90%;overflow:hidden;text-overflow:ellipsis';
      const art = document.querySelector('.art');
      if (art) art.appendChild(node);
    }
    if (!node) return;
    node.textContent = (name || 'Аноним') + ' — +' + format(amount);
    node.style.opacity = '1';
    node.style.transform = 'translate(-50%,0)';
    clearTimeout(node._hideTimer);
    node._hideTimer = setTimeout(() => {
      node.style.opacity = '0';
      node.style.transform = 'translate(-50%,-8px)';
    }, 4200);
  }
  window.TearsWidget = {
    setBaseline(state) {
      current = Math.max(0, Number(state.current_amount) || 0);
      goal = Math.max(1, Number(state.goal_amount) || 1);
      currency = String(state.currency || 'RUB').toUpperCase();
      render();
    },
    triggerDonation(amount, donorName, eventId) {
      const value = Number(amount);
      if (!Number.isFinite(value) || value <= 0) return;
      if (eventId && seen.has(eventId)) return;
      if (eventId) { seen.add(eventId); if (seen.size > 500) seen.delete(seen.values().next().value); }
      current += value;
      render();
      toast(String(donorName || 'Аноним'), value);
    }
  };
})();
