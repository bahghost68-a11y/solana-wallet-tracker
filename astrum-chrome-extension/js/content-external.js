/**
 * Astrum Token Scraper — Content Script for external sites
 * (Axiom, Photon, GMGN, DexScreener, Pump.fun, Twitter/X, Telegram)
 *
 * Detects when the Astrum extension injects its trading panel overlay,
 * then scrapes token data from that panel.
 */

(function () {
  'use strict';

  const SOLANA_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  // Selectors that Astrum-like panels commonly use
  const PANEL_SELECTORS = [
    '[class*="astrum"]',
    '[id*="astrum"]',
    '[data-astrum]',
    '[class*="trading-panel"]',
    '[class*="trade-panel"]',
    '[class*="overlay-panel"]',
    'iframe[src*="astrum"]',
    'div[style*="z-index"][style*="position: fixed"]'
  ];

  function findAstrumPanel() {
    for (const selector of PANEL_SELECTORS) {
      const el = document.querySelector(selector);
      if (el) return el;
    }

    // Also look for shadow DOMs that extensions sometimes use
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      if (el.shadowRoot) {
        for (const selector of PANEL_SELECTORS) {
          const found = el.shadowRoot.querySelector(selector);
          if (found) return found;
        }
      }
    }

    return null;
  }

  function scrapeAstrumPanel(panel) {
    if (!panel) return null;

    const data = { _source: 'external-page-panel' };
    const text = panel.innerText || '';

    // Extract Solana addresses
    const addresses = text.match(SOLANA_ADDRESS_RE) || [];
    if (addresses.length > 0) {
      data.address = addresses[0];
      data._allAddresses = [...new Set(addresses)];
    }

    // Extract labeled values
    const lines = text.split('\n').map(l => l.trim()).filter(l => l);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].toLowerCase();
      const nextLine = lines[i + 1] || '';

      if (line.includes('health')) data.healthIndex = nextLine || extractInlineValue(lines[i]);
      if (line.includes('tradab')) data.tradability = nextLine || extractInlineValue(lines[i]);
      if (line.includes('astrum') && line.includes('index')) data.astrumIndex = nextLine || extractInlineValue(lines[i]);
      if (line.includes('dev') && (line.includes('stat') || line.includes('score'))) data.devStats = nextLine || extractInlineValue(lines[i]);
      if (line.includes('price') && !line.includes('impact')) data.price = nextLine || extractInlineValue(lines[i]);
      if (line.includes('market') && line.includes('cap')) data.marketCap = nextLine || extractInlineValue(lines[i]);
      if (line.includes('liquid')) data.liquidity = nextLine || extractInlineValue(lines[i]);
      if (line.includes('volume') || line.includes('vol 24h')) data.volume = nextLine || extractInlineValue(lines[i]);
      if (line.includes('holder')) data.holders = nextLine || extractInlineValue(lines[i]);
      if (line.includes('supply')) data.supply = nextLine || extractInlineValue(lines[i]);
      if (line.includes('age') || line.includes('created')) data.age = nextLine || extractInlineValue(lines[i]);
      if (line.includes('lp') && line.includes('burn')) data.lpBurned = nextLine || extractInlineValue(lines[i]);
      if (line.includes('mint') && line.includes('auth')) data.mintAuth = nextLine || extractInlineValue(lines[i]);
      if (line.includes('freeze') && line.includes('auth')) data.freezeAuth = nextLine || extractInlineValue(lines[i]);
      if (line.includes('bundl') || line.includes('jito')) data.bundled = nextLine || extractInlineValue(lines[i]);
      if (line.includes('symbol') || line.includes('ticker')) data.symbol = nextLine || extractInlineValue(lines[i]);
      if (line.includes('name') && i === 0) data.name = lines[i];
    }

    // Also look for structured elements inside the panel
    const valueElements = panel.querySelectorAll(
      '[class*="value"], [class*="score"], [class*="stat"], [class*="metric"], ' +
      '[class*="number"], [class*="amount"], [class*="percent"]'
    );
    valueElements.forEach(el => {
      const label = el.getAttribute('class') || '';
      const val = el.textContent.trim();
      if (label.includes('health')) data.healthIndex = data.healthIndex || val;
      if (label.includes('tradab')) data.tradability = data.tradability || val;
      if (label.includes('index') || label.includes('score')) data.astrumIndex = data.astrumIndex || val;
    });

    return Object.keys(data).length > 2 ? data : null;
  }

  function extractInlineValue(line) {
    const parts = line.split(/[:\s]+/);
    return parts.length > 1 ? parts.slice(1).join(' ').trim() : null;
  }

  // Monitor for Astrum panel injection
  let lastScrapeData = null;

  function checkForPanel() {
    const panel = findAstrumPanel();
    if (panel) {
      const data = scrapeAstrumPanel(panel);
      if (data && JSON.stringify(data) !== JSON.stringify(lastScrapeData)) {
        lastScrapeData = data;
        chrome.runtime.sendMessage({
          type: 'ASTRUM_DOM_DATA',
          data: data
        }).catch(() => {});
      }
    }
  }

  // Observe DOM for panel injection
  const observer = new MutationObserver(() => {
    checkForPanel();
  });

  function init() {
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true
      });
    }
    // Check periodically
    setInterval(checkForPanel, 5000);
    checkForPanel();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
