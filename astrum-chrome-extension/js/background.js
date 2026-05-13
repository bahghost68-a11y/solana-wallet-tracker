/**
 * Astrum Token Scraper — Background Service Worker
 *
 * Intercepts network requests to/from astrum.trade API to capture
 * raw token data responses before they reach the Astrum extension UI.
 * Stores captured data in chrome.storage.local and forwards it to the popup.
 */

const ASTRUM_API_PATTERNS = [
  'astrum.trade/api/',
  'astrum.trade/v1/',
  'astrum.trade/token',
  'astrum.trade/health',
  'astrum.trade/index',
  'astrum.trade/dev',
  'astrum.trade/market',
  'astrum.trade/analytics',
  'astrum.trade/paca',
  'astrum.trade/signal',
];

// Store for captured token data
let capturedTokens = {};
let lastApiResponses = [];

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ASTRUM_TOKEN_DATA') {
    handleTokenData(message.data, message.source);
    sendResponse({ success: true });
  }

  if (message.type === 'ASTRUM_API_INTERCEPTED') {
    handleApiResponse(message.url, message.data);
    sendResponse({ success: true });
  }

  if (message.type === 'GET_TOKEN_DATA') {
    const tokenAddress = message.address;
    if (tokenAddress && capturedTokens[tokenAddress]) {
      sendResponse({ data: capturedTokens[tokenAddress] });
    } else {
      sendResponse({ data: null, all: capturedTokens });
    }
  }

  if (message.type === 'GET_ALL_TOKENS') {
    sendResponse({ tokens: capturedTokens, apiResponses: lastApiResponses.slice(-50) });
  }

  if (message.type === 'CLEAR_DATA') {
    capturedTokens = {};
    lastApiResponses = [];
    chrome.storage.local.set({ capturedTokens: {}, apiResponses: [] });
    sendResponse({ success: true });
  }

  if (message.type === 'ASTRUM_DOM_DATA') {
    handleDomData(message.data);
    sendResponse({ success: true });
  }

  return true;
});

function handleTokenData(data, source) {
  if (!data) return;

  const address = data.address || data.mint || data.tokenAddress || data.contract;
  if (!address) {
    // Store as latest unnamed token
    capturedTokens['_latest'] = {
      ...data,
      _capturedAt: Date.now(),
      _source: source || 'content-script'
    };
  } else {
    capturedTokens[address] = {
      ...(capturedTokens[address] || {}),
      ...data,
      _capturedAt: Date.now(),
      _source: source || 'content-script'
    };
  }

  // Persist to storage
  chrome.storage.local.set({ capturedTokens });

  // Notify popup if open
  chrome.runtime.sendMessage({
    type: 'TOKEN_DATA_UPDATED',
    tokens: capturedTokens
  }).catch(() => {});
}

function handleApiResponse(url, data) {
  const entry = {
    url,
    data,
    timestamp: Date.now()
  };
  lastApiResponses.push(entry);

  // Keep only last 100 responses
  if (lastApiResponses.length > 100) {
    lastApiResponses = lastApiResponses.slice(-100);
  }

  // Try to extract token data from API response
  if (data && typeof data === 'object') {
    extractTokenFromApiResponse(data, url);
  }

  chrome.storage.local.set({ apiResponses: lastApiResponses.slice(-50) });
}

function handleDomData(data) {
  if (!data) return;
  const address = data.address || data.mint || '_dom_latest';
  capturedTokens[address] = {
    ...(capturedTokens[address] || {}),
    ...data,
    _capturedAt: Date.now(),
    _source: 'dom-scraper'
  };

  chrome.storage.local.set({ capturedTokens });

  chrome.runtime.sendMessage({
    type: 'TOKEN_DATA_UPDATED',
    tokens: capturedTokens
  }).catch(() => {});
}

function extractTokenFromApiResponse(data, url) {
  // Attempt to parse common token data structures from API responses
  const tokenFields = [
    'token', 'tokenData', 'tokenInfo', 'coin', 'asset',
    'result', 'data', 'payload'
  ];

  for (const field of tokenFields) {
    if (data[field] && typeof data[field] === 'object') {
      handleTokenData(data[field], `api:${url}`);
      return;
    }
  }

  // If the data itself looks like token data
  if (data.address || data.mint || data.symbol || data.healthIndex || data.tradability) {
    handleTokenData(data, `api:${url}`);
  }
}

// Restore data from storage on startup
chrome.storage.local.get(['capturedTokens', 'apiResponses'], (result) => {
  if (result.capturedTokens) capturedTokens = result.capturedTokens;
  if (result.apiResponses) lastApiResponses = result.apiResponses;
});

// Monitor requests to astrum.trade via webRequest (headers only in MV3)
chrome.webRequest.onCompleted.addListener(
  (details) => {
    // Log Astrum API calls for debugging
    const isApi = ASTRUM_API_PATTERNS.some(p => details.url.includes(p));
    if (isApi) {
      lastApiResponses.push({
        url: details.url,
        statusCode: details.statusCode,
        timestamp: Date.now(),
        type: details.type,
        note: 'webRequest:onCompleted (headers only)'
      });
    }
  },
  { urls: ['https://*.astrum.trade/*'] }
);
