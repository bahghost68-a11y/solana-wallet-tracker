/**
 * Astrum Token Scraper — Content Script (astrum.trade pages)
 *
 * Two strategies:
 *   1. DOM Scraping — observe the page for token data elements
 *   2. Network Interception — hijack XHR/Fetch to capture API responses
 */

(function () {
  'use strict';

  const SOLANA_ADDRESS_RE = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

  // ─── Network Interception ────────────────────────────────────────────
  // Inject a script into the page context to intercept XHR and Fetch
  function injectInterceptor() {
    const script = document.createElement('script');
    script.textContent = `
      (function() {
        // ── Fetch interceptor ──
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
          const response = await originalFetch.apply(this, args);
          try {
            const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
            if (url.includes('astrum.trade')) {
              const clone = response.clone();
              clone.json().then(data => {
                window.postMessage({
                  type: '__ASTRUM_SCRAPER_FETCH__',
                  url: url,
                  data: data
                }, '*');
              }).catch(() => {});
            }
          } catch (e) {}
          return response;
        };

        // ── XHR interceptor ──
        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
          this._astrumUrl = url;
          return originalOpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.send = function(...args) {
          this.addEventListener('load', function() {
            try {
              if (this._astrumUrl && this._astrumUrl.includes('astrum.trade')) {
                const data = JSON.parse(this.responseText);
                window.postMessage({
                  type: '__ASTRUM_SCRAPER_XHR__',
                  url: this._astrumUrl,
                  data: data
                }, '*');
              }
            } catch (e) {}
          });
          return originalSend.apply(this, args);
        };

        // ── WebSocket interceptor ──
        const OriginalWebSocket = window.WebSocket;
        window.WebSocket = function(url, protocols) {
          const ws = protocols
            ? new OriginalWebSocket(url, protocols)
            : new OriginalWebSocket(url);

          if (url && url.includes('astrum')) {
            ws.addEventListener('message', function(event) {
              try {
                const data = JSON.parse(event.data);
                window.postMessage({
                  type: '__ASTRUM_SCRAPER_WS__',
                  url: url,
                  data: data
                }, '*');
              } catch (e) {}
            });
          }
          return ws;
        };
        window.WebSocket.prototype = OriginalWebSocket.prototype;
        window.WebSocket.CONNECTING = OriginalWebSocket.CONNECTING;
        window.WebSocket.OPEN = OriginalWebSocket.OPEN;
        window.WebSocket.CLOSING = OriginalWebSocket.CLOSING;
        window.WebSocket.CLOSED = OriginalWebSocket.CLOSED;
      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  // Listen for intercepted data from page context
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const msg = event.data;

    if (msg.type === '__ASTRUM_SCRAPER_FETCH__' ||
        msg.type === '__ASTRUM_SCRAPER_XHR__' ||
        msg.type === '__ASTRUM_SCRAPER_WS__') {
      chrome.runtime.sendMessage({
        type: 'ASTRUM_API_INTERCEPTED',
        url: msg.url,
        data: msg.data
      }).catch(() => {});

      // Also try to extract token-specific data
      if (msg.data && typeof msg.data === 'object') {
        chrome.runtime.sendMessage({
          type: 'ASTRUM_TOKEN_DATA',
          data: msg.data,
          source: msg.type
        }).catch(() => {});
      }
    }
  });

  // ─── DOM Scraping ────────────────────────────────────────────────────

  // Common selectors and text patterns for Astrum token data
  const DATA_PATTERNS = {
    healthIndex: [
      /health\s*index/i, /health\s*score/i, /health/i
    ],
    tradability: [
      /tradability/i, /tradability\s*score/i, /trade\s*score/i
    ],
    astrumIndex: [
      /astrum\s*index/i, /astrum\s*score/i, /ai\s*index/i
    ],
    devStats: [
      /dev\s*stats/i, /developer/i, /dev\s*score/i, /dev\s*info/i
    ],
    price: [
      /price/i, /\$/i
    ],
    marketCap: [
      /market\s*cap/i, /mcap/i, /m\.cap/i
    ],
    liquidity: [
      /liquidity/i, /liq/i
    ],
    volume: [
      /volume/i, /vol\s*24h/i, /24h\s*vol/i
    ],
    holders: [
      /holders/i, /holder\s*count/i
    ],
    supply: [
      /supply/i, /total\s*supply/i, /circulating/i
    ],
    age: [
      /age/i, /created/i, /launched/i
    ],
    buyTax: [
      /buy\s*tax/i
    ],
    sellTax: [
      /sell\s*tax/i
    ],
    lpBurned: [
      /lp\s*burn/i, /burned/i
    ],
    mintAuth: [
      /mint\s*auth/i, /mint\s*authority/i
    ],
    freezeAuth: [
      /freeze\s*auth/i, /freeze\s*authority/i
    ],
    topHolders: [
      /top\s*holders/i, /top\s*10/i, /whale/i
    ],
    bundled: [
      /bundl/i, /jito/i
    ],
    symbol: [
      /symbol/i, /ticker/i
    ],
    name: [
      /token\s*name/i, /name/i
    ]
  };

  function scrapeTokenData() {
    const data = {};

    // 1. Find token address from URL or page
    const urlMatch = window.location.href.match(SOLANA_ADDRESS_RE);
    if (urlMatch) {
      data.address = urlMatch[0];
    }

    // 2. Scrape visible text elements
    const allElements = document.querySelectorAll(
      '[class*="token"], [class*="health"], [class*="index"], [class*="score"], ' +
      '[class*="tradab"], [class*="dev"], [class*="price"], [class*="market"], ' +
      '[class*="liquid"], [class*="volume"], [class*="holder"], [class*="supply"], ' +
      '[class*="stat"], [class*="info"], [class*="detail"], [class*="metric"], ' +
      '[class*="card"], [class*="panel"], [class*="data"], [data-token], [data-mint], ' +
      '[data-address], [data-value], [data-score]'
    );

    allElements.forEach(el => {
      // Check data attributes
      if (el.dataset.token) data.address = data.address || el.dataset.token;
      if (el.dataset.mint) data.address = data.address || el.dataset.mint;
      if (el.dataset.address) data.address = data.address || el.dataset.address;
      if (el.dataset.value) data._dataValues = data._dataValues || [];
      if (el.dataset.score) data._scores = data._scores || [];
    });

    // 3. Scan all text nodes for label → value pairs
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null
    );

    const textPairs = [];
    while (walker.nextNode()) {
      const text = walker.currentNode.textContent.trim();
      if (text.length > 0 && text.length < 200) {
        textPairs.push({
          text,
          element: walker.currentNode.parentElement
        });
      }
    }

    // Match text pairs against patterns
    for (const { text, element } of textPairs) {
      for (const [key, patterns] of Object.entries(DATA_PATTERNS)) {
        for (const pattern of patterns) {
          if (pattern.test(text)) {
            // Look for value in sibling or next element
            const value = findValueNear(element);
            if (value !== null && value !== undefined) {
              data[key] = value;
            }
            break;
          }
        }
      }
    }

    // 4. Look for Solana addresses in the page
    const bodyText = document.body.innerText;
    const addresses = bodyText.match(SOLANA_ADDRESS_RE) || [];
    if (addresses.length > 0 && !data.address) {
      // Use first address that looks like a token mint (not a wallet)
      data.address = addresses[0];
    }
    data._allAddresses = [...new Set(addresses)].slice(0, 20);

    // 5. Extract from structured data (JSON-LD, meta tags)
    const metaTags = document.querySelectorAll('meta[property], meta[name]');
    metaTags.forEach(meta => {
      const name = (meta.getAttribute('property') || meta.getAttribute('name') || '').toLowerCase();
      const content = meta.getAttribute('content');
      if (name.includes('token') || name.includes('coin')) {
        data._meta = data._meta || {};
        data._meta[name] = content;
      }
    });

    return data;
  }

  function findValueNear(element) {
    if (!element) return null;

    // Check next sibling
    const next = element.nextElementSibling;
    if (next) {
      const val = extractValue(next.textContent);
      if (val !== null) return val;
    }

    // Check parent's next sibling
    const parentNext = element.parentElement?.nextElementSibling;
    if (parentNext) {
      const val = extractValue(parentNext.textContent);
      if (val !== null) return val;
    }

    // Check children
    const children = element.parentElement?.children;
    if (children && children.length > 1) {
      for (let i = 0; i < children.length; i++) {
        if (children[i] !== element) {
          const val = extractValue(children[i].textContent);
          if (val !== null) return val;
        }
      }
    }

    return null;
  }

  function extractValue(text) {
    if (!text) return null;
    text = text.trim();
    if (text.length === 0 || text.length > 100) return null;

    // Number with optional % or $ or unit
    const numMatch = text.match(/[\$]?\s*([\d,]+\.?\d*)\s*(%|[KMBTkmbt])?/);
    if (numMatch) return text.trim();

    // Short text value
    if (text.length < 50) return text;

    return null;
  }

  // ─── MutationObserver — re-scrape on DOM changes ─────────────────────
  let scrapeTimeout = null;
  function scheduleScrape() {
    if (scrapeTimeout) clearTimeout(scrapeTimeout);
    scrapeTimeout = setTimeout(() => {
      const data = scrapeTokenData();
      if (data && Object.keys(data).length > 1) {
        chrome.runtime.sendMessage({
          type: 'ASTRUM_DOM_DATA',
          data: data
        }).catch(() => {});
      }
    }, 1500);
  }

  const observer = new MutationObserver((mutations) => {
    const hasRelevantChange = mutations.some(m =>
      m.addedNodes.length > 0 ||
      (m.type === 'characterData')
    );
    if (hasRelevantChange) {
      scheduleScrape();
    }
  });

  // ─── Initialize ──────────────────────────────────────────────────────
  function init() {
    injectInterceptor();

    // Start observing
    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    // Initial scrape after page is loaded
    scheduleScrape();

    // Periodic scrape every 10 seconds
    setInterval(scheduleScrape, 10000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
