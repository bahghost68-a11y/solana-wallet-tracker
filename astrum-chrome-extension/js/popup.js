/**
 * Astrum Token Scraper — Popup Script
 *
 * Displays captured token data, API logs, and raw data
 * with real-time updates from the background service worker.
 */

(function () {
  'use strict';

  // ─── State ───────────────────────────────────────────────────────────
  let tokens = {};
  let apiResponses = [];
  let selectedToken = null;

  // ─── DOM refs ────────────────────────────────────────────────────────
  const tokenList = document.getElementById('token-list');
  const apiList = document.getElementById('api-list');
  const rawData = document.getElementById('raw-data');
  const statusDot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');
  const modal = document.getElementById('token-modal');
  const modalTitle = document.getElementById('modal-title');
  const modalBody = document.getElementById('modal-body');

  // ─── Tabs ────────────────────────────────────────────────────────────
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // ─── Buttons ─────────────────────────────────────────────────────────
  document.getElementById('btn-refresh').addEventListener('click', loadData);

  document.getElementById('btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify({ tokens, apiResponses }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `astrum-tokens-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('Données exportées !');
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CLEAR_DATA' }, () => {
      tokens = {};
      apiResponses = [];
      renderTokens();
      renderApi();
      renderRaw();
      updateStatus();
      showToast('Données effacées');
    });
  });

  document.getElementById('modal-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });

  document.getElementById('modal-copy').addEventListener('click', () => {
    if (selectedToken) {
      navigator.clipboard.writeText(JSON.stringify(selectedToken, null, 2));
      showToast('JSON copié !');
    }
  });

  document.getElementById('modal-export').addEventListener('click', () => {
    if (selectedToken) {
      const addr = selectedToken.address || selectedToken.mint || 'token';
      const blob = new Blob([JSON.stringify(selectedToken, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `astrum-${addr}-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Token exporté !');
    }
  });

  // ─── Data loading ────────────────────────────────────────────────────
  function loadData() {
    chrome.runtime.sendMessage({ type: 'GET_ALL_TOKENS' }, (response) => {
      if (response) {
        tokens = response.tokens || {};
        apiResponses = response.apiResponses || [];
        renderTokens();
        renderApi();
        renderRaw();
        updateStatus();
      }
    });
  }

  // ─── Real-time updates ──────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'TOKEN_DATA_UPDATED') {
      tokens = message.tokens || tokens;
      renderTokens();
      renderRaw();
      updateStatus();
    }
  });

  // ─── Render tokens ──────────────────────────────────────────────────
  function renderTokens() {
    const keys = Object.keys(tokens).filter(k => k !== '_latest');

    if (keys.length === 0 && !tokens._latest) {
      tokenList.innerHTML = `
        <div class="empty-state">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#475569" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
          <p>Aucun token capturé</p>
          <p class="hint">Naviguez sur <strong>app.astrum.trade</strong> ou un site supporté (Axiom, Photon, GMGN...) avec l'extension Astrum active.</p>
        </div>`;
      return;
    }

    // Add _latest if exists
    if (tokens._latest && !keys.includes('_latest')) {
      keys.unshift('_latest');
    }

    tokenList.innerHTML = keys.map(key => {
      const t = tokens[key];
      const addr = t.address || t.mint || t.tokenAddress || key;
      const displayAddr = addr.length > 20 ? `${addr.slice(0, 8)}...${addr.slice(-6)}` : addr;
      const name = t.name || t.symbol || 'Token inconnu';
      const symbol = t.symbol || '';

      return `
        <div class="token-card" data-key="${key}">
          <div class="token-card-header">
            <span class="token-name">${escapeHtml(name)}</span>
            ${symbol ? `<span class="token-symbol">${escapeHtml(symbol)}</span>` : ''}
          </div>
          <div class="token-address">${escapeHtml(displayAddr)}</div>
          <div class="token-metrics">
            ${renderMetric('Health', t.healthIndex, 'green')}
            ${renderMetric('Tradability', t.tradability, 'blue')}
            ${renderMetric('Astrum Idx', t.astrumIndex, 'yellow')}
            ${renderMetric('Prix', t.price, '')}
            ${renderMetric('MCap', t.marketCap, '')}
            ${renderMetric('Liquidité', t.liquidity, '')}
            ${renderMetric('Volume', t.volume, '')}
            ${renderMetric('Holders', t.holders, '')}
            ${renderMetric('Dev', t.devStats, '')}
          </div>
          <div class="token-meta">
            <span>Source: ${escapeHtml(t._source || 'N/A')}</span>
            <span>${t._capturedAt ? timeAgo(t._capturedAt) : ''}</span>
          </div>
        </div>`;
    }).join('');

    // Add click handlers
    tokenList.querySelectorAll('.token-card').forEach(card => {
      card.addEventListener('click', () => {
        const key = card.dataset.key;
        openTokenModal(tokens[key]);
      });
    });
  }

  function renderMetric(label, value, colorClass) {
    if (!value && value !== 0) return '';
    return `
      <div class="metric">
        <div class="metric-label">${label}</div>
        <div class="metric-value ${colorClass}">${escapeHtml(String(value))}</div>
      </div>`;
  }

  // ─── Render API logs ────────────────────────────────────────────────
  function renderApi() {
    if (apiResponses.length === 0) {
      apiList.innerHTML = '<div class="empty-state"><p>Aucune requête API interceptée</p></div>';
      return;
    }

    const sorted = [...apiResponses].reverse();
    apiList.innerHTML = sorted.map((entry, i) => {
      const statusClass = (entry.statusCode && entry.statusCode >= 400) ? 'error' : 'ok';
      const statusLabel = entry.statusCode || (entry.data ? '200' : '?');
      return `
        <div class="api-entry" data-index="${apiResponses.length - 1 - i}">
          <div>
            <span class="api-status ${statusClass}">${statusLabel}</span>
            <span class="api-url">${escapeHtml(entry.url || 'N/A')}</span>
          </div>
          <div class="api-time">${entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : ''}</div>
        </div>`;
    }).join('');

    apiList.querySelectorAll('.api-entry').forEach(entry => {
      entry.addEventListener('click', () => {
        const idx = parseInt(entry.dataset.index);
        const data = apiResponses[idx];
        if (data) {
          rawData.textContent = JSON.stringify(data, null, 2);
          document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
          document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
          document.querySelector('.tab[data-tab="raw"]').classList.add('active');
          document.getElementById('tab-raw').classList.add('active');
        }
      });
    });
  }

  // ─── Render raw data ────────────────────────────────────────────────
  function renderRaw() {
    rawData.textContent = JSON.stringify({ tokens, apiResponseCount: apiResponses.length }, null, 2);
  }

  // ─── Token detail modal ─────────────────────────────────────────────
  function openTokenModal(token) {
    selectedToken = token;
    const addr = token.address || token.mint || token.tokenAddress || 'N/A';
    modalTitle.textContent = token.name || token.symbol || addr.slice(0, 12) + '...';

    const SECTIONS = {
      'Identité': ['address', 'mint', 'tokenAddress', 'contract', 'name', 'symbol'],
      'Scores Astrum': ['healthIndex', 'tradability', 'astrumIndex', 'devStats'],
      'Marché': ['price', 'marketCap', 'liquidity', 'volume'],
      'Token Info': ['holders', 'supply', 'age', 'buyTax', 'sellTax'],
      'Sécurité': ['lpBurned', 'mintAuth', 'freezeAuth', 'bundled'],
      'Metadata': ['_source', '_capturedAt', '_allAddresses']
    };

    let html = '';
    const renderedKeys = new Set();

    for (const [section, fields] of Object.entries(SECTIONS)) {
      const hasFields = fields.some(f => token[f] !== undefined && token[f] !== null);
      if (!hasFields) continue;

      html += `<div class="section-header">${section}</div>`;
      for (const field of fields) {
        if (token[field] === undefined || token[field] === null) continue;
        renderedKeys.add(field);
        let value = token[field];

        if (field === '_capturedAt') value = new Date(value).toLocaleString();
        if (field === '_allAddresses' && Array.isArray(value)) value = value.join(', ');
        if (typeof value === 'object') value = JSON.stringify(value);

        html += `
          <div class="detail-row">
            <span class="detail-label">${formatLabel(field)}</span>
            <span class="detail-value">${escapeHtml(String(value))}</span>
          </div>`;
      }
    }

    // Render remaining fields
    const remaining = Object.keys(token).filter(k => !renderedKeys.has(k) && !k.startsWith('_'));
    if (remaining.length > 0) {
      html += `<div class="section-header">Autres données</div>`;
      for (const key of remaining) {
        let value = token[key];
        if (typeof value === 'object') value = JSON.stringify(value);
        html += `
          <div class="detail-row">
            <span class="detail-label">${formatLabel(key)}</span>
            <span class="detail-value">${escapeHtml(String(value))}</span>
          </div>`;
      }
    }

    modalBody.innerHTML = html;
    modal.classList.remove('hidden');
  }

  // ─── Status ─────────────────────────────────────────────────────────
  function updateStatus() {
    const count = Object.keys(tokens).filter(k => k !== '_latest').length + (tokens._latest ? 1 : 0);
    if (count > 0) {
      statusDot.classList.add('active');
      statusText.textContent = `${count} token(s) capturé(s) · ${apiResponses.length} requête(s) API`;
    } else {
      statusDot.classList.remove('active');
      statusText.textContent = 'En attente de données...';
    }
  }

  // ─── Utils ──────────────────────────────────────────────────────────
  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatLabel(key) {
    return key
      .replace(/([A-Z])/g, ' $1')
      .replace(/[_-]/g, ' ')
      .replace(/^\s+/, '')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  function timeAgo(ts) {
    const diff = Date.now() - ts;
    if (diff < 60000) return 'À l\'instant';
    if (diff < 3600000) return `Il y a ${Math.floor(diff / 60000)} min`;
    if (diff < 86400000) return `Il y a ${Math.floor(diff / 3600000)}h`;
    return new Date(ts).toLocaleDateString();
  }

  function showToast(message) {
    let toast = document.querySelector('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 2000);
  }

  // ─── Init ───────────────────────────────────────────────────────────
  loadData();

  // Auto-refresh every 5 seconds
  setInterval(loadData, 5000);
})();
