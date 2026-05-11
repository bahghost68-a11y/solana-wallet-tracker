#!/usr/bin/env node

const WebSocket = require("ws");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const entryTracker = require("./entryTracker");
const bundleTracker = require("./bundleTracker");

// ─── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  // FluxRPC endpoints
  RPC_HTTP: process.env.FLUXRPC_HTTP || "https://eu.fluxrpc.com",
  RPC_WS: process.env.FLUXRPC_WS || "wss://ws.eu.fluxrpc.com",
  API_KEY: process.env.FLUXRPC_API_KEY || "",

  // Telegram
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || "",
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || "",

  // Threshold: percentage of balance that must be sent to consider it "all SOL"
  TRANSFER_THRESHOLD: parseFloat(process.env.TRANSFER_THRESHOLD || "0.95"),

  // Polling interval in ms for balance checks
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL || "5000", 10),

  // Reconnect delay in ms
  RECONNECT_DELAY: parseInt(process.env.RECONNECT_DELAY || "3000", 10),

  // Commitment level
  COMMITMENT: process.env.COMMITMENT || "confirmed",

  // Telegram polling interval
  TELEGRAM_POLL_INTERVAL: parseInt(process.env.TELEGRAM_POLL_INTERVAL || "2000", 10),

  // Data file for persisting tracked wallets
  DATA_FILE: process.env.DATA_FILE || path.join(__dirname, "wallets.json"),
};

// Known program IDs
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const METADATA_PROGRAM = "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

// Known launchpad / DEX programs
const KNOWN_LAUNCHPADS = {
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P": "pump.fun",
  "pumpkinfCnfqEjbTPAdw3XAhpbxU2sEgxRTmEJBGFP3": "pump.fun (v2)",
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo": "Meteora DLMM",
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB": "Meteora Pools",
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8": "Raydium AMM",
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK": "Raydium CLMM",
  "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C": "Raydium CPMM",
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc": "Orca Whirlpool",
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4": "Jupiter v6",
};

const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
const MINT_CREATION_TYPES = ["initializeMint", "initializeMint2"];
const MINT_LOG_PATTERNS = ["InitializeMint", "InitializeMint2"];

// ─── State ──────────────────────────────────────────────────────────────────
// Each tracked wallet: { address, balance, accountSubId, logsSubId, history[], label }
let trackedWallets = new Map();
let ws = null;
let rpcId = 1;
let isShuttingDown = false;
const reportedSignatures = new Set();

// ─── Logging ────────────────────────────────────────────────────────────────
function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function logWarn(msg) {
  const ts = new Date().toISOString();
  console.warn(`[${ts}] ⚠ ${msg}`);
}

function logSuccess(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ✓ ${msg}`);
}

function logAlert(msg) {
  const ts = new Date().toISOString();
  console.log(`\n${"=".repeat(60)}`);
  console.log(`[${ts}] 🚨 ${msg}`);
  console.log(`${"=".repeat(60)}\n`);
}

// ─── Telegram Bot ───────────────────────────────────────────────────────────
let telegramOffset = 0;

function telegramRequest(method, params = {}) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.TELEGRAM_BOT_TOKEN) {
      resolve(null);
      return;
    }

    const body = JSON.stringify(params);
    const options = {
      hostname: "api.telegram.org",
      port: 443,
      path: `/bot${CONFIG.TELEGRAM_BOT_TOKEN}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          resolve(json);
        } catch (e) {
          reject(new Error(`Telegram parse error: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function sendTelegram(text, chatId = null) {
  const targetChat = chatId || CONFIG.TELEGRAM_CHAT_ID;
  if (!CONFIG.TELEGRAM_BOT_TOKEN || !targetChat) return;

  try {
    await telegramRequest("sendMessage", {
      chat_id: targetChat,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    logWarn(`Erreur Telegram: ${e.message}`);
  }
}

let telegramPolling = false;
async function pollTelegram() {
  if (!CONFIG.TELEGRAM_BOT_TOKEN || isShuttingDown || telegramPolling) return;
  telegramPolling = true;

  try {
    const result = await telegramRequest("getUpdates", {
      offset: telegramOffset,
      timeout: 1,
      allowed_updates: ["message"],
    });

    if (!result || !result.ok || !result.result) return;

    for (const update of result.result) {
      telegramOffset = update.update_id + 1;
      if (update.message && update.message.text) {
        const chatId = update.message.chat.id.toString();
        const text = update.message.text.trim();

        // Auto-set chat ID if not configured
        if (!CONFIG.TELEGRAM_CHAT_ID) {
          CONFIG.TELEGRAM_CHAT_ID = chatId;
          log(`Chat ID Telegram configuré: ${chatId}`);
        }

        await handleTelegramCommand(text, chatId);
      }
    }
  } catch (e) {
    // Silently ignore polling errors
  } finally {
    telegramPolling = false;
  }
}

async function handleTelegramCommand(text, chatId) {
  const parts = text.split(/\s+/);
  const command = parts[0].toLowerCase().replace(/@\w+$/, "");

  switch (command) {
    case "/start":
      await sendTelegram(
        "🤖 <b>Solana Wallet Tracker Bot</b>\n\n" +
        "Commandes disponibles:\n" +
        "/add <code>&lt;adresse&gt;</code> [label] — Ajouter un wallet à suivre\n" +
        "/remove <code>&lt;adresse&gt;</code> — Supprimer un wallet\n" +
        "/list — Voir tous les wallets suivis\n" +
        "/status — État du bot et connexions\n" +
        "/help — Afficher cette aide",
        chatId
      );
      break;

    case "/help":
      await sendTelegram(
        "📖 <b>Aide</b>\n\n" +
        "<b>Commandes Wallet:</b>\n" +
        "/add <code>&lt;adresse&gt;</code> [label] — Ajouter un wallet\n" +
        "/remove <code>&lt;adresse&gt;</code> — Supprimer un wallet\n" +
        "/list — Liste des wallets suivis\n" +
        "/status — État du bot\n\n" +
        "<b>Commandes Entry Tracker:</b>\n" +
        "/pools — Pools détectés récemment\n" +
        "/check <code>&lt;mint&gt;</code> — Vérifier la sécurité d'un token\n" +
        "/entry — Config de l'entry tracker\n\n" +
        "<b>Commandes Bundle Tracker:</b>\n" +
        "/bundle — Stats du bundle tracker\n" +
        "/bundles — Jito bundles détectés\n" +
        "/analyze <code>&lt;tx_sig&gt;</code> — Analyser une TX manuellement\n\n" +
        "<b>Fonctionnement:</b>\n" +
        "• Suivi wallets en temps réel + chain-following\n" +
        "• Détection création de tokens\n" +
        "• Entry Tracker: pools Raydium/Pump.fun + VolumeSpike\n" +
        "• Bundle Tracker: détecte Jito bundles (Block 0 sniping)\n" +
        "• Vérification sécurité (Mint Authority + LP burn)",
        chatId
      );
      break;

    case "/add": {
      const address = parts[1];
      const label = parts.slice(2).join(" ") || "";

      if (!address) {
        await sendTelegram("❌ Usage: /add <code>&lt;adresse_wallet&gt;</code> [label]", chatId);
        return;
      }

      if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) {
        await sendTelegram("❌ Adresse invalide (format base58 attendu)", chatId);
        return;
      }

      if (trackedWallets.has(address)) {
        await sendTelegram(`⚠️ Wallet déjà suivi: <code>${address}</code>`, chatId);
        return;
      }

      try {
        const balance = await getBalance(address);
        await addWallet(address, label, balance);
        await sendTelegram(
          `✅ <b>Wallet ajouté</b>\n` +
          `📍 <code>${address}</code>\n` +
          (label ? `🏷 Label: ${label}\n` : "") +
          `💰 Balance: ${(balance / 1e9).toFixed(4)} SOL`,
          chatId
        );
      } catch (e) {
        await sendTelegram(`❌ Erreur: ${e.message}`, chatId);
      }
      break;
    }

    case "/remove": {
      const address = parts[1];
      if (!address) {
        await sendTelegram("❌ Usage: /remove <code>&lt;adresse_wallet&gt;</code>", chatId);
        return;
      }

      if (!trackedWallets.has(address)) {
        // Try partial match
        const match = [...trackedWallets.keys()].find(
          (w) => w.startsWith(address) || w.endsWith(address)
        );
        if (match) {
          removeWallet(match);
          await sendTelegram(`✅ Wallet supprimé: <code>${match}</code>`, chatId);
        } else {
          await sendTelegram("❌ Wallet non trouvé", chatId);
        }
        return;
      }

      removeWallet(address);
      await sendTelegram(`✅ Wallet supprimé: <code>${address}</code>`, chatId);
      break;
    }

    case "/list": {
      if (trackedWallets.size === 0) {
        await sendTelegram("📋 Aucun wallet suivi.\nUtilisez /add pour en ajouter.", chatId);
        return;
      }

      let msg = `📋 <b>Wallets suivis (${trackedWallets.size}):</b>\n\n`;
      let i = 1;
      for (const [addr, info] of trackedWallets) {
        const bal = (info.balance / 1e9).toFixed(4);
        const lbl = info.label ? ` (${info.label})` : "";
        const hist = info.history.length > 0
          ? `\n   ↳ ${info.history.length} switch(es)`
          : "";
        msg += `${i}. <code>${addr.slice(0, 8)}...${addr.slice(-4)}</code>${lbl}\n   💰 ${bal} SOL${hist}\n\n`;
        i++;
      }
      await sendTelegram(msg, chatId);
      break;
    }

    case "/status": {
      const wsStatus = ws && ws.readyState === WebSocket.OPEN ? "✅ Connecté" : "❌ Déconnecté";
      const uptime = process.uptime();
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);

      await sendTelegram(
        `📊 <b>Status du Bot</b>\n\n` +
        `🔌 WebSocket: ${wsStatus}\n` +
        `👛 Wallets suivis: ${trackedWallets.size}\n` +
        `⏱ Uptime: ${hours}h ${mins}m\n` +
        `🔄 Seuil transfert: ${(CONFIG.TRANSFER_THRESHOLD * 100).toFixed(0)}%\n` +
        `📡 RPC: ${CONFIG.RPC_HTTP}`,
        chatId
      );
      break;
    }

    default: {
      // Try entry tracker commands, then bundle tracker
      let handled = await entryTracker.handleCommand(command, parts, chatId);
      if (!handled) handled = await bundleTracker.handleCommand(command, parts, chatId);
      if (!handled && text.startsWith("/")) {
        await sendTelegram("❓ Commande inconnue. Tapez /help pour l'aide.", chatId);
      }
      break;
    }
  }
}

// ─── Wallet Persistence ─────────────────────────────────────────────────────

function saveWallets() {
  const data = {};
  for (const [addr, info] of trackedWallets) {
    data[addr] = {
      label: info.label,
      history: info.history,
      addedAt: info.addedAt,
    };
  }
  try {
    fs.writeFileSync(CONFIG.DATA_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    logWarn(`Erreur sauvegarde wallets: ${e.message}`);
  }
}

function loadWallets() {
  try {
    if (fs.existsSync(CONFIG.DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.DATA_FILE, "utf8"));
      return data;
    }
  } catch (e) {
    logWarn(`Erreur chargement wallets: ${e.message}`);
  }
  return {};
}

// ─── Multi-Wallet Management ────────────────────────────────────────────────

async function addWallet(address, label = "", initialBalance = null) {
  if (trackedWallets.has(address)) return;

  const balance = initialBalance !== null ? initialBalance : await getBalance(address);

  trackedWallets.set(address, {
    address,
    label,
    balance,
    accountSubId: null,
    logsSubId: null,
    history: [],
    addedAt: new Date().toISOString(),
  });

  log(`Wallet ajouté: ${address}${label ? ` (${label})` : ""} | ${(balance / 1e9).toFixed(4)} SOL`);

  // Subscribe on WebSocket
  if (ws && ws.readyState === WebSocket.OPEN) {
    await subscribeWallet(address);
  }

  saveWallets();
}

function removeWallet(address) {
  const info = trackedWallets.get(address);
  if (!info) return;

  // Unsubscribe
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (info.accountSubId !== null) {
      wsSend({ method: "accountUnsubscribe", params: [info.accountSubId] }).catch(() => {});
    }
    if (info.logsSubId !== null) {
      wsSend({ method: "logsUnsubscribe", params: [info.logsSubId] }).catch(() => {});
    }
  }

  trackedWallets.delete(address);
  log(`Wallet supprimé: ${address}`);
  saveWallets();
}

async function switchWallet(oldAddress, newAddress, reason) {
  const info = trackedWallets.get(oldAddress);
  if (!info) return;

  info.history.push({
    from: oldAddress,
    to: newAddress,
    reason,
    timestamp: new Date().toISOString(),
  });

  // Remove old wallet subscriptions
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (info.accountSubId !== null) {
      wsSend({ method: "accountUnsubscribe", params: [info.accountSubId] }).catch(() => {});
    }
    if (info.logsSubId !== null) {
      wsSend({ method: "logsUnsubscribe", params: [info.logsSubId] }).catch(() => {});
    }
  }

  // Update the entry to track the new wallet
  const newBalance = await getBalance(newAddress);
  const history = info.history;
  const label = info.label;
  const addedAt = info.addedAt;

  trackedWallets.delete(oldAddress);
  trackedWallets.set(newAddress, {
    address: newAddress,
    label,
    balance: newBalance,
    accountSubId: null,
    logsSubId: null,
    history,
    addedAt,
  });

  // Subscribe to new wallet
  if (ws && ws.readyState === WebSocket.OPEN) {
    await subscribeWallet(newAddress);
  }

  const msg =
    `🔄 <b>SWITCH WALLET</b>\n\n` +
    `📤 De: <code>${oldAddress}</code>\n` +
    `📥 Vers: <code>${newAddress}</code>\n` +
    `💰 Nouvelle balance: ${(newBalance / 1e9).toFixed(4)} SOL\n` +
    `📝 Raison: ${reason}\n` +
    `🔗 Chaîne: ${history.length} switch(es)`;

  logAlert(`SWITCH: ${oldAddress.slice(0, 8)}... → ${newAddress.slice(0, 8)}...`);
  log(`Raison: ${reason}`);
  await sendTelegram(msg);

  saveWallets();

  // Scan recent transactions of the new wallet to catch token creation that
  // may have happened right after the transfer (before WebSocket is subscribed)
  log(`Scan des transactions récentes de ${newAddress.slice(0, 8)}...`);
  await sleep(3000);
  await scanForTokenActivity(newAddress);

  // Schedule delayed re-scans to catch token creation that happens seconds later
  setTimeout(async () => {
    log(`Re-scan (10s) de ${newAddress.slice(0, 8)}...`);
    await scanForTokenActivity(newAddress);
  }, 10000);
  setTimeout(async () => {
    log(`Re-scan (30s) de ${newAddress.slice(0, 8)}...`);
    await scanForTokenActivity(newAddress);
  }, 30000);
  setTimeout(async () => {
    log(`Re-scan (60s) de ${newAddress.slice(0, 8)}...`);
    await scanForTokenActivity(newAddress);
  }, 60000);
}

// ─── RPC HTTP Helpers ───────────────────────────────────────────────────────

function buildUrl() {
  const base = CONFIG.RPC_HTTP;
  if (CONFIG.API_KEY) {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}key=${CONFIG.API_KEY}`;
  }
  return base;
}

function rpcCall(method, params) {
  return new Promise((resolve, reject) => {
    const url = new URL(buildUrl());
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: rpcId++,
      method,
      params,
    });

    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === "https:" ? 443 : 80),
      path: url.pathname + url.search,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };

    const transport = url.protocol === "https:" ? https : http;
    const req = transport.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            reject(new Error(`RPC error: ${JSON.stringify(json.error)}`));
          } else {
            resolve(json.result);
          }
        } catch (e) {
          reject(new Error(`Failed to parse RPC response: ${e.message}`));
        }
      });
    });

    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function getBalance(wallet) {
  const result = await rpcCall("getBalance", [
    wallet,
    { commitment: CONFIG.COMMITMENT },
  ]);
  return result.value;
}

async function getSignaturesForAddress(wallet, limit = 10) {
  return rpcCall("getSignaturesForAddress", [
    wallet,
    { limit, commitment: CONFIG.COMMITMENT },
  ]);
}

async function getTransaction(signature) {
  return rpcCall("getTransaction", [
    signature,
    {
      encoding: "jsonParsed",
      commitment: CONFIG.COMMITMENT,
      maxSupportedTransactionVersion: 0,
    },
  ]);
}

// ─── Transaction Analysis ───────────────────────────────────────────────────

function analyzeTransactionForTransfer(tx, trackedWallet) {
  if (!tx || !tx.meta || tx.meta.err) return null;

  const message = tx.transaction.message;
  const accountKeys = message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey
  );

  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;

  const walletIndex = accountKeys.indexOf(trackedWallet);
  if (walletIndex === -1) return null;

  const preBal = preBalances[walletIndex];
  const postBal = postBalances[walletIndex];

  if (preBal === 0) return null;

  const amountSent = preBal - postBal;
  const ratio = amountSent / preBal;

  if (ratio < CONFIG.TRANSFER_THRESHOLD) return null;

  let maxReceived = 0;
  let receiverIndex = -1;

  for (let i = 0; i < accountKeys.length; i++) {
    if (i === walletIndex) continue;
    const received = postBalances[i] - preBalances[i];
    if (received > maxReceived) {
      maxReceived = received;
      receiverIndex = i;
    }
  }

  if (receiverIndex === -1) return null;

  const receiver = accountKeys[receiverIndex];

  const knownPrograms = [
    SYSTEM_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM, METADATA_PROGRAM,
    "ComputeBudget111111111111111111111111111111",
    "SysvarRent111111111111111111111111111111111",
  ];
  if (knownPrograms.includes(receiver)) return null;

  return {
    from: trackedWallet,
    to: receiver,
    amountLamports: amountSent,
    amountSOL: amountSent / 1e9,
    ratio,
    signature: tx.transaction.signatures[0],
  };
}

function analyzeTransactionForTokenCreation(tx, trackedWallet) {
  if (!tx || !tx.meta || tx.meta.err) return null;

  const message = tx.transaction.message;
  const accountKeys = message.accountKeys.map((k) =>
    typeof k === "string" ? k : k.pubkey
  );

  // Check if wallet is involved (as account or fee payer)
  const walletIndex = accountKeys.indexOf(trackedWallet);
  if (walletIndex === -1) return null;

  const results = [];
  const foundMints = new Set();

  const allInstructions = [
    ...(message.instructions || []),
    ...(tx.meta.innerInstructions || []).flatMap((ix) => ix.instructions || []),
  ];

  // Detect launchpad (for info display)
  let launchpadUsed = null;
  for (const ix of allInstructions) {
    const programId = ix.programId || accountKeys[ix.programIdIndex];
    if (KNOWN_LAUNCHPADS[programId]) {
      launchpadUsed = KNOWN_LAUNCHPADS[programId];
    }
  }

  // Method 1: Direct initializeMint / initializeMint2 instructions
  for (const ix of allInstructions) {
    const programId = ix.programId || accountKeys[ix.programIdIndex];

    if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) {
      const parsed = ix.parsed;
      if (parsed && MINT_CREATION_TYPES.includes(parsed.type)) {
        const mintAddress = parsed.info?.mint || null;
        if (mintAddress && mintAddress !== WRAPPED_SOL && !foundMints.has(mintAddress)) {
          foundMints.add(mintAddress);
          results.push({
            type: "token_creation",
            mintAddress,
            program: programId === TOKEN_PROGRAM ? "SPL Token" : "Token-2022",
            creator: trackedWallet,
            signature: tx.transaction.signatures[0],
            launchpad: launchpadUsed,
          });
        }
      }
    }
  }

  // Method 2: createAccount with owner = Token Program where the new account
  // appears as a mint in postTokenBalances (confirms it's a mint, not just a token account)
  const postMintSet = new Set(
    (tx.meta.postTokenBalances || []).map((b) => b.mint)
  );
  for (const ix of allInstructions) {
    const programId = ix.programId || accountKeys[ix.programIdIndex];
    if (programId === SYSTEM_PROGRAM && ix.parsed?.type === "createAccount") {
      const newAccount = ix.parsed.info?.newAccount;
      const owner = ix.parsed.info?.owner;
      if (
        newAccount &&
        newAccount !== WRAPPED_SOL &&
        (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) &&
        postMintSet.has(newAccount) &&
        !foundMints.has(newAccount)
      ) {
        foundMints.add(newAccount);
        results.push({
          type: "token_creation",
          mintAddress: newAccount,
          program: owner === TOKEN_PROGRAM ? "SPL Token" : "Token-2022",
          creator: trackedWallet,
          signature: tx.transaction.signatures[0],
          launchpad: launchpadUsed,
        });
      }
    }
  }

  // Method 3: New mints in postTokenBalances that don't exist in preTokenBalances
  // This is the most reliable method - works for ANY token creation (direct, CPI, launchpad)
  const preMints = new Set(
    (tx.meta.preTokenBalances || []).map((b) => b.mint)
  );
  for (const tb of tx.meta.postTokenBalances || []) {
    if (
      !preMints.has(tb.mint) &&
      tb.mint !== WRAPPED_SOL &&
      !foundMints.has(tb.mint)
    ) {
      foundMints.add(tb.mint);
      results.push({
        type: "token_creation",
        mintAddress: tb.mint,
        program: tb.programId || "unknown",
        creator: trackedWallet,
        signature: tx.transaction.signatures[0],
        launchpad: launchpadUsed,
      });
    }
  }

  return results.length > 0 ? results : null;
}

async function reportTokenFindings(tx, wallet) {
  const tokens = analyzeTransactionForTokenCreation(tx, wallet);
  if (tokens && tokens.length > 0) {
    for (const token of tokens) {
      if (token.type === "token_creation") {
        const launchpadInfo = token.launchpad ? `\n🏪 Plateforme: ${token.launchpad}` : "";
        const walletInfo = trackedWallets.get(wallet);
        const labelInfo = walletInfo?.label ? ` (${walletInfo.label})` : "";

        const msg =
          `🪙 <b>NOUVEAU TOKEN CREE!</b>\n\n` +
          `📋 Mint: <code>${token.mintAddress}</code>\n` +
          `🔧 Programme: ${token.program}${launchpadInfo}\n` +
          `👤 Créateur: <code>${token.creator}</code>${labelInfo}\n` +
          `🔗 TX: <code>${token.signature.slice(0, 32)}...</code>`;

        logAlert(
          `TOKEN CREE!\n` +
          `  Mint: ${token.mintAddress}\n` +
          `  Programme: ${token.program}\n` +
          `  Créateur: ${token.creator}`
        );
        await sendTelegram(msg);
      }
    }
  }
  return tokens;
}

// ─── Transaction Scanning ───────────────────────────────────────────────────

async function scanForTokenActivity(walletAddress) {
  try {
    const sigs = await getSignaturesForAddress(walletAddress, 10);
    if (!sigs || sigs.length === 0) return;

    for (const sigInfo of sigs) {
      if (sigInfo.err) continue;
      if (reportedSignatures.has(sigInfo.signature)) continue;

      const tx = await getTransaction(sigInfo.signature);
      if (!tx) continue;

      const tokens = await reportTokenFindings(tx, walletAddress);
      if (tokens && tokens.length > 0) {
        reportedSignatures.add(sigInfo.signature);
      }
    }
  } catch (e) {
    logWarn(`Erreur scan token (${walletAddress.slice(0, 8)}...): ${e.message}`);
  }
}

async function analyzeRecentTransactions(walletAddress) {
  try {
    const sigs = await getSignaturesForAddress(walletAddress, 10);
    if (!sigs || sigs.length === 0) {
      log(`Aucune TX récente pour ${walletAddress.slice(0, 8)}...`);
      return;
    }

    for (const sigInfo of sigs) {
      if (sigInfo.err) continue;

      const tx = await getTransaction(sigInfo.signature);
      if (!tx) continue;

      // Check for token creation
      if (!reportedSignatures.has(sigInfo.signature)) {
        const tokens = await reportTokenFindings(tx, walletAddress);
        if (tokens && tokens.length > 0) {
          reportedSignatures.add(sigInfo.signature);
        }
      }

      // Check for full SOL transfer
      const transfer = analyzeTransactionForTransfer(tx, walletAddress);
      if (transfer) {
        const walletInfo = trackedWallets.get(walletAddress);
        const labelInfo = walletInfo?.label ? ` (${walletInfo.label})` : "";

        const msg =
          `💸 <b>TRANSFERT TOTAL</b>\n\n` +
          `📤 De: <code>${transfer.from}</code>${labelInfo}\n` +
          `📥 Vers: <code>${transfer.to}</code>\n` +
          `💰 Montant: ${transfer.amountSOL.toFixed(4)} SOL (${(transfer.ratio * 100).toFixed(1)}%)\n` +
          `🔗 TX: <code>${transfer.signature.slice(0, 32)}...</code>`;

        logAlert(`TRANSFERT: ${transfer.from.slice(0, 8)}... → ${transfer.to.slice(0, 8)}...`);
        await sendTelegram(msg);

        reportedSignatures.clear();

        await switchWallet(
          walletAddress,
          transfer.to,
          `Transfert de ${transfer.amountSOL.toFixed(4)} SOL (${(transfer.ratio * 100).toFixed(1)}%)`
        );
        return;
      }
    }

    log(`Aucun transfert total pour ${walletAddress.slice(0, 8)}...`);
  } catch (e) {
    logWarn(`Erreur analyse TX (${walletAddress.slice(0, 8)}...): ${e.message}`);
  }
}

// ─── WebSocket Management ───────────────────────────────────────────────────

function getWsUrl() {
  const base = CONFIG.RPC_WS;
  if (CONFIG.API_KEY) {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}key=${CONFIG.API_KEY}`;
  }
  return base;
}

function wsSend(payload) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error("WebSocket not connected"));
      return;
    }
    const id = rpcId++;
    payload.id = id;
    payload.jsonrpc = "2.0";
    ws.send(JSON.stringify(payload), (err) => {
      if (err) reject(err);
      else resolve(id);
    });
  });
}

async function subscribeWallet(address) {
  const info = trackedWallets.get(address);
  if (!info) return;

  try {
    await wsSend({
      method: "accountSubscribe",
      params: [address, { encoding: "jsonParsed", commitment: CONFIG.COMMITMENT }],
    });
    log(`accountSubscribe envoyé pour ${address.slice(0, 8)}...`);
  } catch (e) {
    logWarn(`Erreur accountSubscribe: ${e.message}`);
  }

  try {
    await wsSend({
      method: "logsSubscribe",
      params: [{ mentions: [address] }, { commitment: CONFIG.COMMITMENT }],
    });
    log(`logsSubscribe envoyé pour ${address.slice(0, 8)}...`);
  } catch (e) {
    logWarn(`Erreur logsSubscribe: ${e.message}`);
  }
}

async function subscribeAllWallets() {
  for (const address of trackedWallets.keys()) {
    await subscribeWallet(address);
  }
}

// Map subscription IDs to wallet addresses
const subIdToWallet = new Map();
let pendingSubQueue = [];

async function handleWsMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  // Handle subscription confirmation
  if (msg.id && msg.result !== undefined && typeof msg.result === "number") {
    const subId = msg.result;
    // Assign to pending wallet
    if (pendingSubQueue.length > 0) {
      const { address, type } = pendingSubQueue.shift();
      subIdToWallet.set(subId, { address, type });
      const info = trackedWallets.get(address);
      if (info) {
        if (type === "account") info.accountSubId = subId;
        else if (type === "logs") info.logsSubId = subId;
      }
      logSuccess(`${type}Subscribe confirmé pour ${address.slice(0, 8)}... (subId=${subId})`);
    }
    return;
  }

  // Handle notifications
  if (msg.method === "accountNotification") {
    const subId = msg.params?.subscription;
    const walletInfo = subIdToWallet.get(subId);
    if (walletInfo) {
      await handleAccountNotification(walletInfo.address, msg.params);
    }
  } else if (msg.method === "logsNotification") {
    const subId = msg.params?.subscription;
    const walletInfo = subIdToWallet.get(subId);
    if (walletInfo && walletInfo.type === "entry_logs") {
      // Entry tracker log notification
      const result = msg.params?.result;
      if (result && result.value) {
        const { signature, logs } = result.value;
        if (signature && logs) {
          await entryTracker.handleLogNotification(signature, logs);
        }
      }
    } else if (walletInfo && walletInfo.type === "bundle_logs") {
      // Bundle tracker log notification
      const result = msg.params?.result;
      if (result && result.value) {
        const { signature, logs } = result.value;
        if (signature && logs) {
          await bundleTracker.handleLogNotification(signature, logs);
        }
      }
    } else if (walletInfo) {
      await handleLogsNotification(walletInfo.address, msg.params);
    }
  }
}

const processingWallets = new Set();

async function handleAccountNotification(walletAddress, params) {
  if (processingWallets.has(walletAddress)) return;
  processingWallets.add(walletAddress);

  try {
    const info = trackedWallets.get(walletAddress);
    if (!info) return;

    const accountInfo = params?.result?.value;
    if (!accountInfo) return;

    const newBalance = accountInfo.lamports;
    const oldBalance = info.balance;

    log(
      `Balance: ${(oldBalance / 1e9).toFixed(4)} → ${(newBalance / 1e9).toFixed(4)} SOL (${walletAddress.slice(0, 8)}...)`
    );

    // Check for massive transfer (wallet emptied)
    if (oldBalance > 0 && newBalance < oldBalance) {
      const ratio = (oldBalance - newBalance) / oldBalance;

      if (ratio >= CONFIG.TRANSFER_THRESHOLD) {
        log(`Transfert massif détecté! (${walletAddress.slice(0, 8)}...)`);
        info.balance = newBalance;
        await analyzeRecentTransactions(walletAddress);
        return;
      }
    }

    // Scan for token activity on any balance change
    if (newBalance !== oldBalance) {
      await scanForTokenActivity(walletAddress);
    }

    info.balance = newBalance;
  } catch (e) {
    logWarn(`Erreur notification (${walletAddress.slice(0, 8)}...): ${e.message}`);
  } finally {
    processingWallets.delete(walletAddress);
  }
}

async function handleLogsNotification(walletAddress, params) {
  const result = params?.result;
  if (!result || !result.value) return;

  const { signature, logs } = result.value;
  if (!signature || !logs) return;

  if (reportedSignatures.has(signature)) return;

  // Broader detection: mint patterns, launchpad programs, or token program invocations
  const hasTokenCreation = logs.some((l) =>
    MINT_LOG_PATTERNS.some((p) => l.includes(p)) ||
    Object.keys(KNOWN_LAUNCHPADS).some((p) => l.includes(p)) ||
    l.includes(TOKEN_PROGRAM) ||
    l.includes(TOKEN_2022_PROGRAM) ||
    l.includes("Program log: Instruction: Create")
  );

  if (hasTokenCreation) {
    log(`Possible création de token (${walletAddress.slice(0, 8)}..., sig: ${signature.slice(0, 16)}...)`);
    try {
      await sleep(2000);
      const tx = await getTransaction(signature);
      if (tx) {
        const tokens = await reportTokenFindings(tx, walletAddress);
        if (tokens && tokens.length > 0) {
          reportedSignatures.add(signature);
        }
      }
    } catch (e) {
      logWarn(`Erreur analyse token: ${e.message}`);
    }
  }
}

// Override subscribeWallet to track pending subs
const originalSubscribeWallet = subscribeWallet;
async function subscribeWalletTracked(address) {
  const info = trackedWallets.get(address);
  if (!info) return;

  try {
    pendingSubQueue.push({ address, type: "account" });
    await wsSend({
      method: "accountSubscribe",
      params: [address, { encoding: "jsonParsed", commitment: CONFIG.COMMITMENT }],
    });
    log(`accountSubscribe envoyé pour ${address.slice(0, 8)}...`);
  } catch (e) {
    pendingSubQueue.pop();
    logWarn(`Erreur accountSubscribe: ${e.message}`);
  }

  try {
    pendingSubQueue.push({ address, type: "logs" });
    await wsSend({
      method: "logsSubscribe",
      params: [{ mentions: [address] }, { commitment: CONFIG.COMMITMENT }],
    });
    log(`logsSubscribe envoyé pour ${address.slice(0, 8)}...`);
  } catch (e) {
    pendingSubQueue.pop();
    logWarn(`Erreur logsSubscribe: ${e.message}`);
  }
}

// ─── WebSocket Connection ───────────────────────────────────────────────────

function connectWebSocket() {
  if (isShuttingDown) return;

  const url = getWsUrl();
  log(`Connexion WebSocket: ${CONFIG.RPC_WS}...`);

  ws = new WebSocket(url);

  ws.on("open", async () => {
    logSuccess("WebSocket connecté!");
    subIdToWallet.clear();
    pendingSubQueue = [];
    for (const address of trackedWallets.keys()) {
      await subscribeWalletTracked(address);
    }
    // Subscribe entry tracker to pool programs
    if (entryTracker.ENTRY_CONFIG.ENABLED) {
      await entryTracker.subscribeToPrograms();
    }
    // Subscribe bundle tracker to Pump.fun
    if (bundleTracker.enabled) {
      await bundleTracker.subscribeToPumpFun();
    }
  });

  ws.on("message", (data) => {
    handleWsMessage(data).catch((e) => {
      logWarn(`Erreur message WS: ${e.message}`);
    });
  });

  ws.on("error", (err) => {
    logWarn(`Erreur WebSocket: ${err.message}`);
  });

  ws.on("close", (code) => {
    logWarn(`WebSocket fermé (code=${code}). Reconnexion dans ${CONFIG.RECONNECT_DELAY}ms...`);
    subIdToWallet.clear();
    for (const info of trackedWallets.values()) {
      info.accountSubId = null;
      info.logsSubId = null;
    }
    if (!isShuttingDown) {
      setTimeout(connectWebSocket, CONFIG.RECONNECT_DELAY);
    }
  });

  const pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
}

// ─── Polling Fallback ───────────────────────────────────────────────────────

async function pollBalances() {
  if (isShuttingDown) return;

  for (const [address, info] of trackedWallets) {
    try {
      const balance = await getBalance(address);
      const oldBalance = info.balance;

      if (balance !== oldBalance) {
        if (oldBalance > 0 && balance < oldBalance) {
          const ratio = (oldBalance - balance) / oldBalance;
          if (ratio >= CONFIG.TRANSFER_THRESHOLD) {
            log(`[Poll] Transfert massif détecté (${address.slice(0, 8)}...)`);
            info.balance = balance;
            await analyzeRecentTransactions(address);
            continue;
          }
        }
        info.balance = balance;
      }
    } catch (e) {
      // Silent
    }
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║       SOLANA WALLET TRACKER BOT + TELEGRAM              ║
║       Powered by FluxRPC                                ║
╚══════════════════════════════════════════════════════════╝
`);
}

function printConfig() {
  log("Configuration:");
  log(`  RPC HTTP: ${CONFIG.RPC_HTTP}`);
  log(`  RPC WS:   ${CONFIG.RPC_WS}`);
  log(`  API Key:  ${CONFIG.API_KEY ? CONFIG.API_KEY.slice(0, 8) + "..." : "(aucune)"}`);
  log(`  Telegram: ${CONFIG.TELEGRAM_BOT_TOKEN ? "✓ configuré" : "✗ non configuré"}`);
  log(`  Chat ID:  ${CONFIG.TELEGRAM_CHAT_ID || "(auto-détection au 1er message)"}`);
  log(`  Seuil:    ${(CONFIG.TRANSFER_THRESHOLD * 100).toFixed(0)}%`);
  log(`  Polling:  ${CONFIG.POLL_INTERVAL}ms`);
  log(`  Entry Tracker: ${entryTracker.ENTRY_CONFIG.ENABLED ? "✓ activé" : "✗ désactivé"}`);
  if (entryTracker.ENTRY_CONFIG.ENABLED) {
    log(`    Volume: ${entryTracker.ENTRY_CONFIG.VOLUME_THRESHOLD} acheteurs / ${entryTracker.ENTRY_CONFIG.VOLUME_WINDOW_MS / 1000}s`);
    log(`    Auto-achat: ${entryTracker.ENTRY_CONFIG.AUTO_BUY ? "✓" : "✗"}`);
  }
  log(`  Bundle Tracker: ${bundleTracker.enabled ? "✓ activé" : "✗ désactivé"}`);
  console.log();
}

function printUsage() {
  console.log(`
Usage: node index.js [WALLET_ADDRESS...]

  Ajouter des wallets au démarrage (optionnel).
  Les wallets peuvent aussi être ajoutés via Telegram: /add <adresse>

Variables d'environnement:
  FLUXRPC_API_KEY       - Clé API FluxRPC (requis)
  FLUXRPC_HTTP          - URL RPC HTTP (défaut: https://eu.fluxrpc.com)
  FLUXRPC_WS            - URL WebSocket (défaut: wss://ws.eu.fluxrpc.com)
  TELEGRAM_BOT_TOKEN    - Token du bot Telegram (requis pour Telegram)
  TELEGRAM_CHAT_ID      - ID du chat Telegram (auto-détecté si vide)
  TRANSFER_THRESHOLD    - Seuil de transfert (défaut: 0.95)
  POLL_INTERVAL         - Intervalle polling en ms (défaut: 5000)
  COMMITMENT            - Niveau commitment (défaut: confirmed)
  ENTRY_TRACKER         - Activer entry tracker (défaut: true, false pour désactiver)
  VOLUME_THRESHOLD      - Acheteurs uniques pour VolumeSpike (défaut: 50)
  VOLUME_WINDOW_MS      - Fenêtre glissante en ms (défaut: 10000)
  BUY_AMOUNT_SOL        - Montant d'achat en SOL (défaut: 0.1)
  AUTO_BUY              - Auto-achat activé (défaut: false)
  BASE_SLIPPAGE_BPS     - Slippage de base en bps (défaut: 500)
  MAX_SLIPPAGE_BPS      - Slippage max en bps (défaut: 3000)
  BUNDLE_TRACKER        - Activer bundle tracker Jito (défaut: true)

Exemples:
  # Avec Telegram uniquement (ajouter wallets via /add)
  FLUXRPC_API_KEY=xxx TELEGRAM_BOT_TOKEN=yyy node index.js

  # Avec wallets en CLI + Telegram
  FLUXRPC_API_KEY=xxx TELEGRAM_BOT_TOKEN=yyy node index.js wallet1 wallet2

  # Sans Telegram (console uniquement)
  FLUXRPC_API_KEY=xxx node index.js wallet1
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  if (!CONFIG.API_KEY) {
    printUsage();
    logWarn("FLUXRPC_API_KEY est requis!");
    process.exit(1);
  }

  printConfig();

  // Load saved wallets
  const savedWallets = loadWallets();
  for (const [addr, data] of Object.entries(savedWallets)) {
    try {
      const balance = await getBalance(addr);
      trackedWallets.set(addr, {
        address: addr,
        label: data.label || "",
        balance,
        accountSubId: null,
        logsSubId: null,
        history: data.history || [],
        addedAt: data.addedAt || new Date().toISOString(),
      });
      log(`Wallet restauré: ${addr.slice(0, 8)}... | ${(balance / 1e9).toFixed(4)} SOL`);
    } catch (e) {
      logWarn(`Impossible de restaurer ${addr.slice(0, 8)}...: ${e.message}`);
    }
  }

  // Add CLI wallets
  const cliWallets = process.argv.slice(2).filter((a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a));
  for (const addr of cliWallets) {
    if (!trackedWallets.has(addr)) {
      try {
        const balance = await getBalance(addr);
        await addWallet(addr, "", balance);
      } catch (e) {
        logWarn(`Erreur ajout ${addr.slice(0, 8)}...: ${e.message}`);
      }
    }
  }

  if (trackedWallets.size > 0) {
    logSuccess(`${trackedWallets.size} wallet(s) en cours de suivi`);
  } else {
    log("Aucun wallet à suivre. Ajoutez-en via Telegram (/add) ou en CLI.");
  }

  // Initialize entry tracker module
  entryTracker.init({
    config: CONFIG,
    wsSend,
    rpcCall,
    sendTelegram,
    log,
    logWarn,
    logSuccess,
    logAlert,
    pendingSubQueue,
  });

  if (entryTracker.ENTRY_CONFIG.ENABLED) {
    log("Entry Tracker activé — surveillance Raydium + Pump.fun");
  }

  // Initialize bundle tracker module
  bundleTracker.init({
    config: CONFIG,
    wsSend,
    rpcCall,
    sendTelegram,
    log,
    logWarn,
    logSuccess,
    logAlert,
    pendingSubQueue,
  });

  if (bundleTracker.enabled) {
    log("Bundle Tracker activé — détection Jito Bundle sur Pump.fun");
  }

  // Connect WebSocket
  connectWebSocket();

  // Start polling fallback
  setInterval(pollBalances, CONFIG.POLL_INTERVAL);

  // Start Telegram polling
  if (CONFIG.TELEGRAM_BOT_TOKEN) {
    log("Démarrage polling Telegram...");
    setInterval(pollTelegram, CONFIG.TELEGRAM_POLL_INTERVAL);

    // Send startup message
    if (CONFIG.TELEGRAM_CHAT_ID) {
      const walletCount = trackedWallets.size;
      await sendTelegram(
        `🟢 <b>Bot démarré</b>\n` +
        `👛 ${walletCount} wallet(s) en suivi\n` +
        `Tapez /help pour les commandes`
      );
    }
  } else {
    log("Telegram non configuré (TELEGRAM_BOT_TOKEN manquant)");
  }

  log("Bot en cours d'exécution. Ctrl+C pour arrêter.\n");
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", async () => {
  console.log();
  log("Arrêt du bot...");
  isShuttingDown = true;

  if (CONFIG.TELEGRAM_BOT_TOKEN && CONFIG.TELEGRAM_CHAT_ID) {
    await sendTelegram("🔴 <b>Bot arrêté</b>");
  }

  if (ws) ws.close();

  saveWallets();
  log("Au revoir!");
  process.exit(0);
});

process.on("unhandledRejection", (err) => {
  logWarn(`Erreur non gérée: ${err.message || err}`);
});

// Start
main().catch((e) => {
  logWarn(`Erreur fatale: ${e.message}`);
  process.exit(1);
});
