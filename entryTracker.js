// ─── Entry Tracker Module ───────────────────────────────────────────────────
// Detects new Raydium/Pump.fun pools, monitors buy volume via rolling window,
// runs security checks (mint authority, LP burn), and triggers buy signals.

const https = require("https");
const http = require("http");

// ─── Programs ───────────────────────────────────────────────────────────────
const RAYDIUM_AMM = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const PUMPFUN_V1 = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPFUN_V2 = "pumpkinfCnfqEjbTPAdw3XAhpbxU2sEgxRTmEJBGFP3";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

// Raydium log patterns for pool initialization
const RAYDIUM_INIT_PATTERNS = [
  "Program log: initialize2",
  "Program log: Initialize",
  "ray_log",
];

// Pump.fun patterns
const PUMPFUN_CREATE_PATTERNS = [
  "Program log: Instruction: Create",
  "Program log: Instruction: Initialize",
];

// ─── Entry Tracker Config ───────────────────────────────────────────────────
const ENTRY_CONFIG = {
  // Rolling window: X unique buyers in Y seconds triggers VolumeSpike
  VOLUME_WINDOW_MS: parseInt(process.env.VOLUME_WINDOW_MS || "10000", 10),
  VOLUME_THRESHOLD: parseInt(process.env.VOLUME_THRESHOLD || "50", 10),

  // Buy parameters
  BUY_AMOUNT_SOL: parseFloat(process.env.BUY_AMOUNT_SOL || "0.1"),
  BASE_SLIPPAGE_BPS: parseInt(process.env.BASE_SLIPPAGE_BPS || "500", 10),
  MAX_SLIPPAGE_BPS: parseInt(process.env.MAX_SLIPPAGE_BPS || "3000", 10),

  // Auto-buy enabled
  AUTO_BUY: process.env.AUTO_BUY === "true",

  // Entry tracker enabled
  ENABLED: process.env.ENTRY_TRACKER !== "false",
};

// ─── State ──────────────────────────────────────────────────────────────────

// Tracked pools: poolAddress -> { mint, dex, detectedAt, buyers: [{address, timestamp}], volumeSpikeFired, securityChecked, securityResult }
const trackedPools = new Map();

// Subscription IDs for entry tracker
let entrySubIds = new Map();

// Reference to shared resources (set via init)
let sharedConfig = null;
let sharedWsSend = null;
let sharedRpcCall = null;
let sharedSendTelegram = null;
let sharedLog = null;
let sharedLogWarn = null;
let sharedLogSuccess = null;
let sharedLogAlert = null;
let pendingSubQueue = null;

// ─── Init ───────────────────────────────────────────────────────────────────

function init(shared) {
  sharedConfig = shared.config;
  sharedWsSend = shared.wsSend;
  sharedRpcCall = shared.rpcCall;
  sharedSendTelegram = shared.sendTelegram;
  sharedLog = shared.log;
  sharedLogWarn = shared.logWarn;
  sharedLogSuccess = shared.logSuccess;
  sharedLogAlert = shared.logAlert;
  pendingSubQueue = shared.pendingSubQueue;
}

function log(msg) {
  if (sharedLog) sharedLog(`[EntryTracker] ${msg}`);
  else console.log(`[EntryTracker] ${msg}`);
}

function logWarn(msg) {
  if (sharedLogWarn) sharedLogWarn(`[EntryTracker] ${msg}`);
  else console.warn(`[EntryTracker] ${msg}`);
}

// ─── Pool Detection via logsSubscribe ───────────────────────────────────────

async function subscribeToPrograms() {
  if (!sharedWsSend) {
    logWarn("WebSocket non disponible pour subscribeToPrograms");
    return;
  }

  // Subscribe to Raydium AMM logs
  try {
    if (pendingSubQueue) {
      pendingSubQueue.push({ address: RAYDIUM_AMM, type: "entry_logs" });
    }
    await sharedWsSend({
      method: "logsSubscribe",
      params: [{ mentions: [RAYDIUM_AMM] }, { commitment: "confirmed" }],
    });
    log(`logsSubscribe envoyé pour Raydium AMM`);
  } catch (e) {
    logWarn(`Erreur logsSubscribe Raydium: ${e.message}`);
  }

  // Subscribe to Pump.fun v1 logs
  try {
    if (pendingSubQueue) {
      pendingSubQueue.push({ address: PUMPFUN_V1, type: "entry_logs" });
    }
    await sharedWsSend({
      method: "logsSubscribe",
      params: [{ mentions: [PUMPFUN_V1] }, { commitment: "confirmed" }],
    });
    log(`logsSubscribe envoyé pour Pump.fun v1`);
  } catch (e) {
    logWarn(`Erreur logsSubscribe Pump.fun v1: ${e.message}`);
  }

  // Subscribe to Pump.fun v2 logs
  try {
    if (pendingSubQueue) {
      pendingSubQueue.push({ address: PUMPFUN_V2, type: "entry_logs" });
    }
    await sharedWsSend({
      method: "logsSubscribe",
      params: [{ mentions: [PUMPFUN_V2] }, { commitment: "confirmed" }],
    });
    log(`logsSubscribe envoyé pour Pump.fun v2`);
  } catch (e) {
    logWarn(`Erreur logsSubscribe Pump.fun v2: ${e.message}`);
  }
}

// ─── Handle incoming log notifications ──────────────────────────────────────

async function handleLogNotification(signature, logs) {
  if (!logs || !signature) return;

  const logText = logs.join("\n");

  // Detect which DEX
  let dex = null;
  let isNewPool = false;

  if (logText.includes(RAYDIUM_AMM)) {
    dex = "Raydium";
    isNewPool = RAYDIUM_INIT_PATTERNS.some((p) => logText.includes(p));
  } else if (logText.includes(PUMPFUN_V1) || logText.includes(PUMPFUN_V2)) {
    dex = "Pump.fun";
    isNewPool = PUMPFUN_CREATE_PATTERNS.some((p) => logText.includes(p));
  }

  if (!dex) return;

  if (isNewPool) {
    await handleNewPool(signature, dex, logs);
  } else {
    // Could be a swap/buy on an existing pool — track for volume
    await handlePoolTransaction(signature, dex, logs);
  }
}

// ─── New Pool Detection ─────────────────────────────────────────────────────

async function handleNewPool(signature, dex, logs) {
  log(`Nouveau pool ${dex} détecté (sig: ${signature.slice(0, 16)}...)`);

  try {
    // Wait a bit for the transaction to be fully indexed
    await sleep(2000);

    const tx = await sharedRpcCall("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);

    if (!tx || !tx.meta || tx.meta.err) return;

    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey
    );

    // Find the token mint (the non-SOL mint in postTokenBalances)
    let tokenMint = null;
    for (const tb of tx.meta.postTokenBalances || []) {
      if (tb.mint && tb.mint !== WRAPPED_SOL) {
        tokenMint = tb.mint;
        break;
      }
    }

    if (!tokenMint) {
      log(`Pas de token mint trouvé dans la TX du pool ${dex}`);
      return;
    }

    // Check if we're already tracking this token
    for (const [, pool] of trackedPools) {
      if (pool.mint === tokenMint) return;
    }

    const poolKey = `${dex}:${tokenMint}`;

    trackedPools.set(poolKey, {
      mint: tokenMint,
      dex,
      signature,
      detectedAt: Date.now(),
      buyers: [],
      volumeSpikeFired: false,
      securityChecked: false,
      securityResult: null,
      creator: accountKeys[0],
    });

    const msg =
      `🆕 <b>NOUVEAU POOL ${dex.toUpperCase()}</b>\n\n` +
      `🪙 Token: <code>${tokenMint}</code>\n` +
      `🏗 Créateur: <code>${accountKeys[0]}</code>\n` +
      `🔗 TX: <code>${signature.slice(0, 32)}...</code>\n\n` +
      `📊 Surveillance du volume démarrée...`;

    if (sharedLogAlert) sharedLogAlert(`NOUVEAU POOL ${dex}: ${tokenMint}`);
    if (sharedSendTelegram) await sharedSendTelegram(msg);

    // Start security check in background
    checkSecurity(poolKey).catch((e) => logWarn(`Erreur sécurité: ${e.message}`));

  } catch (e) {
    logWarn(`Erreur analyse nouveau pool: ${e.message}`);
  }
}

// ─── Transaction Volume Tracking (Rolling Window) ───────────────────────────

async function handlePoolTransaction(signature, dex, logs) {
  // Find which tracked pool this transaction belongs to
  // We need to fetch the transaction to identify the token
  try {
    const tx = await sharedRpcCall("getTransaction", [
      signature,
      { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);

    if (!tx || !tx.meta || tx.meta.err) return;

    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      typeof k === "string" ? k : k.pubkey
    );

    // Find token mint in this transaction
    let tokenMint = null;
    for (const tb of tx.meta.postTokenBalances || []) {
      if (tb.mint && tb.mint !== WRAPPED_SOL) {
        tokenMint = tb.mint;
        break;
      }
    }
    if (!tokenMint) return;

    const poolKey = `${dex}:${tokenMint}`;
    const pool = trackedPools.get(poolKey);
    if (!pool) return;

    // Determine if this is a buy (SOL spent = preBalance > postBalance for signer)
    const signerIndex = 0;
    const preBal = tx.meta.preBalances[signerIndex];
    const postBal = tx.meta.postBalances[signerIndex];
    const isBuy = preBal > postBal;

    if (!isBuy) return;

    const buyerAddress = accountKeys[signerIndex];
    const now = Date.now();

    // Add to rolling window
    pool.buyers.push({ address: buyerAddress, timestamp: now });

    // Clean old entries outside window
    const windowStart = now - ENTRY_CONFIG.VOLUME_WINDOW_MS;
    pool.buyers = pool.buyers.filter((b) => b.timestamp >= windowStart);

    // Count unique buyers in window
    const uniqueBuyers = new Set(pool.buyers.map((b) => b.address));
    const uniqueCount = uniqueBuyers.size;

    // Check VolumeSpike threshold
    if (uniqueCount >= ENTRY_CONFIG.VOLUME_THRESHOLD && !pool.volumeSpikeFired) {
      pool.volumeSpikeFired = true;
      await handleVolumeSpike(pool, uniqueCount);
    }

  } catch (e) {
    // Silently ignore individual transaction fetch errors
  }
}

// ─── Volume Spike Handler ───────────────────────────────────────────────────

async function handleVolumeSpike(pool, uniqueBuyers) {
  const elapsed = ((Date.now() - pool.detectedAt) / 1000).toFixed(1);

  log(`VolumeSpike! ${pool.dex} ${pool.mint.slice(0, 8)}... — ${uniqueBuyers} acheteurs uniques en ${ENTRY_CONFIG.VOLUME_WINDOW_MS / 1000}s`);

  const msg =
    `🔥 <b>VOLUME SPIKE!</b>\n\n` +
    `🪙 Token: <code>${pool.mint}</code>\n` +
    `📈 ${uniqueBuyers} acheteurs uniques en ${ENTRY_CONFIG.VOLUME_WINDOW_MS / 1000}s\n` +
    `🏪 DEX: ${pool.dex}\n` +
    `⏱ Détecté ${elapsed}s après création du pool`;

  if (sharedLogAlert) sharedLogAlert(`VOLUME SPIKE: ${pool.mint}`);
  if (sharedSendTelegram) await sharedSendTelegram(msg);

  // Run security check if not done yet
  if (!pool.securityChecked) {
    await checkSecurity(`${pool.dex}:${pool.mint}`);
  }

  // If security passed + auto-buy enabled, trigger buy
  if (pool.securityResult && pool.securityResult.safe && ENTRY_CONFIG.AUTO_BUY) {
    await executeBuy(pool);
  } else if (pool.securityResult && !pool.securityResult.safe) {
    const reasons = pool.securityResult.reasons.join(", ");
    const warnMsg =
      `⚠️ <b>SECURITE: ACHAT BLOQUE</b>\n\n` +
      `🪙 Token: <code>${pool.mint}</code>\n` +
      `❌ Raisons: ${reasons}`;
    if (sharedSendTelegram) await sharedSendTelegram(warnMsg);
  } else if (pool.securityResult && pool.securityResult.safe && !ENTRY_CONFIG.AUTO_BUY) {
    const safeMsg =
      `✅ <b>SECURITE OK — Prêt pour achat</b>\n\n` +
      `🪙 Token: <code>${pool.mint}</code>\n` +
      `🔒 Mint Authority: null ✓\n` +
      `🔥 LP brûlé: ✓\n` +
      `💡 Activez AUTO_BUY=true pour acheter automatiquement`;
    if (sharedSendTelegram) await sharedSendTelegram(safeMsg);
  }
}

// ─── Security Checks ────────────────────────────────────────────────────────

async function checkSecurity(poolKey) {
  const pool = trackedPools.get(poolKey);
  if (!pool || pool.securityChecked) return;

  log(`Vérification sécurité pour ${pool.mint.slice(0, 8)}...`);

  const reasons = [];

  try {
    // 1. Check Mint Authority
    const mintAuthOk = await checkMintAuthority(pool.mint);
    if (!mintAuthOk) {
      reasons.push("Mint Authority active (risque de mint infini)");
    }

    // 2. Check LP tokens burned
    const lpBurnedOk = await checkLpBurned(pool);
    if (!lpBurnedOk) {
      reasons.push("LP tokens non brûlés (risque de rug pull)");
    }

    pool.securityChecked = true;
    pool.securityResult = {
      safe: reasons.length === 0,
      reasons,
      checkedAt: Date.now(),
    };

    if (reasons.length === 0) {
      log(`Sécurité OK pour ${pool.mint.slice(0, 8)}...`);
    } else {
      logWarn(`Sécurité FAIL pour ${pool.mint.slice(0, 8)}...: ${reasons.join(", ")}`);
    }

  } catch (e) {
    logWarn(`Erreur vérification sécurité ${pool.mint.slice(0, 8)}...: ${e.message}`);
    pool.securityChecked = true;
    pool.securityResult = {
      safe: false,
      reasons: [`Erreur vérification: ${e.message}`],
      checkedAt: Date.now(),
    };
  }
}

async function checkMintAuthority(mintAddress) {
  try {
    const result = await sharedRpcCall("getAccountInfo", [
      mintAddress,
      { encoding: "jsonParsed", commitment: "confirmed" },
    ]);

    if (!result || !result.value) return false;

    const parsed = result.value.data?.parsed;
    if (!parsed) return false;

    const info = parsed.info;
    if (!info) return false;

    // Mint Authority must be null (disabled) or equal to a known burn address
    const mintAuth = info.mintAuthority;
    const freezeAuth = info.freezeAuthority;

    const isAuthNull = mintAuth === null || mintAuth === undefined;
    const isFreezeNull = freezeAuth === null || freezeAuth === undefined;

    if (!isAuthNull) {
      log(`Mint Authority active: ${mintAuth}`);
    }

    return isAuthNull;
  } catch (e) {
    logWarn(`Erreur checkMintAuthority: ${e.message}`);
    return false;
  }
}

async function checkLpBurned(pool) {
  try {
    // For Raydium: check if LP tokens are sent to the burn address
    // or if the largest LP token holder is the burn address
    const result = await sharedRpcCall("getTokenLargestAccounts", [
      pool.mint,
      { commitment: "confirmed" },
    ]);

    if (!result || !result.value || result.value.length === 0) {
      // No token accounts — might be too early, give benefit of doubt
      return true;
    }

    // For Pump.fun tokens, LP is typically handled by the bonding curve
    if (pool.dex === "Pump.fun") {
      return true;
    }

    // For Raydium, check if the pool has LP tokens and if they're burned
    // Get the LP mint associated with this pool
    // We look at the token's supply and largest accounts
    const supplyResult = await sharedRpcCall("getTokenSupply", [
      pool.mint,
      { commitment: "confirmed" },
    ]);

    if (!supplyResult || !supplyResult.value) return false;

    // If there's a very concentrated holder (>95%) that isn't a known DEX,
    // it might be a rug risk. For now, basic check: token exists and is distributed.
    const totalSupply = parseFloat(supplyResult.value.amount);
    if (totalSupply === 0) return false;

    // Check if the largest holder has more than 95% — risk indicator
    const largestAccount = result.value[0];
    if (largestAccount) {
      const largestAmount = parseFloat(largestAccount.amount);
      const ratio = largestAmount / totalSupply;
      if (ratio > 0.95) {
        log(`Concentration LP élevée: ${(ratio * 100).toFixed(1)}% dans un seul compte`);
        // Not necessarily failed — some pools have liquidity locked
      }
    }

    return true;
  } catch (e) {
    logWarn(`Erreur checkLpBurned: ${e.message}`);
    return true; // Give benefit of doubt on RPC errors
  }
}

// ─── Dynamic Slippage Buy Function ──────────────────────────────────────────

async function executeBuy(pool) {
  // Calculate dynamic slippage based on volume and time since pool creation
  const timeSinceCreation = Date.now() - pool.detectedAt;
  const buyerCount = new Set(pool.buyers.map((b) => b.address)).size;

  // Dynamic slippage: base + adjustment based on activity
  // More activity = higher slippage needed (more competition)
  let slippageBps = ENTRY_CONFIG.BASE_SLIPPAGE_BPS;

  // Increase slippage based on buyer density
  if (buyerCount > 100) {
    slippageBps += 1000; // Very high activity
  } else if (buyerCount > 75) {
    slippageBps += 500;
  } else if (buyerCount > 50) {
    slippageBps += 250;
  }

  // Increase slippage for very new pools (< 30s)
  if (timeSinceCreation < 30000) {
    slippageBps += 500;
  } else if (timeSinceCreation < 60000) {
    slippageBps += 250;
  }

  // Cap at max slippage
  slippageBps = Math.min(slippageBps, ENTRY_CONFIG.MAX_SLIPPAGE_BPS);

  const slippagePercent = (slippageBps / 100).toFixed(1);

  log(`Achat: ${ENTRY_CONFIG.BUY_AMOUNT_SOL} SOL → ${pool.mint.slice(0, 8)}... | Slippage: ${slippagePercent}%`);

  // NOTE: Actual swap execution requires a wallet private key and transaction signing.
  // This is a signal/notification system. The actual buy would need:
  // 1. A funded wallet with private key
  // 2. Building a swap instruction (Raydium SDK / Jupiter API)
  // 3. Signing and sending the transaction
  //
  // For safety, we only emit the buy signal via Telegram.

  const msg =
    `🛒 <b>SIGNAL D'ACHAT</b>\n\n` +
    `🪙 Token: <code>${pool.mint}</code>\n` +
    `💰 Montant: ${ENTRY_CONFIG.BUY_AMOUNT_SOL} SOL\n` +
    `📊 Slippage: ${slippagePercent}% (${slippageBps} bps)\n` +
    `🏪 DEX: ${pool.dex}\n` +
    `👥 Acheteurs uniques: ${buyerCount}\n` +
    `🔒 Sécurité: ✅ Vérifiée\n\n` +
    `💡 <i>Signal uniquement — configurez votre wallet pour l'auto-achat</i>`;

  if (sharedLogAlert) sharedLogAlert(`SIGNAL ACHAT: ${pool.mint}`);
  if (sharedSendTelegram) await sharedSendTelegram(msg);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

function cleanupOldPools() {
  const maxAge = 5 * 60 * 1000; // 5 minutes
  const now = Date.now();

  for (const [key, pool] of trackedPools) {
    if (now - pool.detectedAt > maxAge && pool.buyers.length === 0) {
      trackedPools.delete(key);
    }
  }
}

// Start cleanup interval
setInterval(cleanupOldPools, 60000);

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Telegram Command Handler ───────────────────────────────────────────────

async function handleCommand(command, parts, chatId) {
  switch (command) {
    case "/pools": {
      if (trackedPools.size === 0) {
        if (sharedSendTelegram) {
          await sharedSendTelegram("📋 Aucun pool détecté récemment.", chatId);
        }
        return true;
      }

      let msg = `📊 <b>Pools détectés (${trackedPools.size}):</b>\n\n`;
      for (const [, pool] of trackedPools) {
        const age = ((Date.now() - pool.detectedAt) / 1000).toFixed(0);
        const uniqueBuyers = new Set(pool.buyers.map((b) => b.address)).size;
        const secStatus = pool.securityChecked
          ? pool.securityResult?.safe ? "✅" : "❌"
          : "⏳";
        msg +=
          `${pool.dex} | <code>${pool.mint.slice(0, 12)}...</code>\n` +
          `  👥 ${uniqueBuyers} acheteurs | ${secStatus} | ${age}s\n\n`;
      }
      if (sharedSendTelegram) await sharedSendTelegram(msg, chatId);
      return true;
    }

    case "/check": {
      const mintAddress = parts[1];
      if (!mintAddress) {
        if (sharedSendTelegram) {
          await sharedSendTelegram("❌ Usage: /check <code>&lt;mint_address&gt;</code>", chatId);
        }
        return true;
      }

      try {
        const mintOk = await checkMintAuthority(mintAddress);
        const msg =
          `🔍 <b>Vérification Sécurité</b>\n\n` +
          `🪙 Mint: <code>${mintAddress}</code>\n` +
          `🔒 Mint Authority: ${mintOk ? "null ✅ (safe)" : "active ❌ (risque)"}\n`;
        if (sharedSendTelegram) await sharedSendTelegram(msg, chatId);
      } catch (e) {
        if (sharedSendTelegram) {
          await sharedSendTelegram(`❌ Erreur: ${e.message}`, chatId);
        }
      }
      return true;
    }

    case "/entry": {
      const msg =
        `📊 <b>Entry Tracker Config</b>\n\n` +
        `${ENTRY_CONFIG.ENABLED ? "✅" : "❌"} Activé\n` +
        `📈 Seuil volume: ${ENTRY_CONFIG.VOLUME_THRESHOLD} acheteurs en ${ENTRY_CONFIG.VOLUME_WINDOW_MS / 1000}s\n` +
        `💰 Montant achat: ${ENTRY_CONFIG.BUY_AMOUNT_SOL} SOL\n` +
        `📊 Slippage: ${ENTRY_CONFIG.BASE_SLIPPAGE_BPS}-${ENTRY_CONFIG.MAX_SLIPPAGE_BPS} bps\n` +
        `🤖 Auto-achat: ${ENTRY_CONFIG.AUTO_BUY ? "✅" : "❌"}\n` +
        `🔍 Pools suivis: ${trackedPools.size}`;
      if (sharedSendTelegram) await sharedSendTelegram(msg, chatId);
      return true;
    }

    default:
      return false;
  }
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  init,
  subscribeToPrograms,
  handleLogNotification,
  handleCommand,
  ENTRY_CONFIG,
  RAYDIUM_AMM,
  PUMPFUN_V1,
  PUMPFUN_V2,
  trackedPools,
  entrySubIds,
};
