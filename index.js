#!/usr/bin/env node

const WebSocket = require("ws");
const https = require("https");
const http = require("http");

// ─── Configuration ──────────────────────────────────────────────────────────
const CONFIG = {
  // FluxRPC endpoints
  RPC_HTTP: process.env.FLUXRPC_HTTP || "https://eu.fluxrpc.com",
  RPC_WS: process.env.FLUXRPC_WS || "wss://ws.eu.fluxrpc.com",
  API_KEY: process.env.FLUXRPC_API_KEY || "",

  // Wallet to track (pass as CLI arg or env var)
  INITIAL_WALLET: process.argv[2] || process.env.TRACK_WALLET || "",

  // Threshold: percentage of balance that must be sent to consider it "all SOL"
  // 0.95 = 95% (accounts for tx fees)
  TRANSFER_THRESHOLD: parseFloat(process.env.TRANSFER_THRESHOLD || "0.95"),

  // Polling interval in ms for balance checks (fallback if WS disconnects)
  POLL_INTERVAL: parseInt(process.env.POLL_INTERVAL || "5000", 10),

  // Reconnect delay in ms
  RECONNECT_DELAY: parseInt(process.env.RECONNECT_DELAY || "3000", 10),

  // Commitment level
  COMMITMENT: process.env.COMMITMENT || "confirmed",
};

// Known program IDs
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

// Metaplex Token Metadata Program
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

// Wrapped SOL mint address — always ignore this
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";

// ONLY these instructions indicate a REAL new token creation
const MINT_CREATION_TYPES = ["initializeMint", "initializeMint2"];

// Log patterns that indicate REAL token creation (not just account init)
const MINT_LOG_PATTERNS = ["InitializeMint", "InitializeMint2"];

// ─── State ──────────────────────────────────────────────────────────────────
let currentWallet = "";
let previousBalance = 0;
let ws = null;
let accountSubId = null;
let logsSubId = null;
let rpcId = 1;
let walletHistory = [];
let isShuttingDown = false;

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

  // Check if the wallet sent almost all its SOL
  if (preBal === 0) return null;

  const amountSent = preBal - postBal;
  const ratio = amountSent / preBal;

  if (ratio < CONFIG.TRANSFER_THRESHOLD) return null;

  // Find who received the SOL
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

  // Ignore if receiver is a known program
  const knownPrograms = [
    SYSTEM_PROGRAM,
    TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ASSOCIATED_TOKEN_PROGRAM,
    METADATA_PROGRAM,
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

  const walletIndex = accountKeys.indexOf(trackedWallet);
  if (walletIndex === -1) return null;

  const results = [];
  const foundMints = new Set();

  const allInstructions = [
    ...(message.instructions || []),
    ...(tx.meta.innerInstructions || []).flatMap((ix) => ix.instructions || []),
  ];

  // Detect launchpad interactions (for info logging)
  let launchpadUsed = null;
  for (const ix of allInstructions) {
    const programId = ix.programId || accountKeys[ix.programIdIndex];
    if (KNOWN_LAUNCHPADS[programId]) {
      launchpadUsed = KNOWN_LAUNCHPADS[programId];
    }
  }

  // Method 1: Direct initializeMint / initializeMint2 instructions (most reliable)
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

  // Method 2: createAccount with owner = Token Program + InitializeMint in logs
  // This catches cases where the mint is created via System Program createAccount
  if (tx.meta.logMessages) {
    const hasMintLog = tx.meta.logMessages.some((l) =>
      MINT_LOG_PATTERNS.some((p) => l.includes(p))
    );

    if (hasMintLog) {
      for (const ix of allInstructions) {
        const programId = ix.programId || accountKeys[ix.programIdIndex];
        if (programId === SYSTEM_PROGRAM && ix.parsed?.type === "createAccount") {
          const newAccount = ix.parsed.info?.newAccount;
          const owner = ix.parsed.info?.owner;
          if (
            newAccount &&
            newAccount !== WRAPPED_SOL &&
            (owner === TOKEN_PROGRAM || owner === TOKEN_2022_PROGRAM) &&
            !foundMints.has(newAccount)
          ) {
            // Verify this is a mint account (size 82 for SPL Token mint)
            const space = ix.parsed.info?.space;
            if (space === 82 || space === undefined) {
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
      }
    }
  }

  // Method 3: Detect via launchpad + new mint in postTokenBalances
  // (pump.fun and similar create the mint inside the program)
  if (launchpadUsed) {
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
  }

  return results.length > 0 ? results : null;
}

// ─── Wallet Switch ──────────────────────────────────────────────────────────

async function switchToWallet(newWallet, reason) {
  const oldWallet = currentWallet;
  walletHistory.push({
    wallet: oldWallet,
    switchedTo: newWallet,
    reason,
    timestamp: new Date().toISOString(),
  });

  logAlert(
    `SWITCH WALLET: ${oldWallet.slice(0, 8)}...${oldWallet.slice(-4)} → ${newWallet.slice(0, 8)}...${newWallet.slice(-4)}`
  );
  log(`Raison: ${reason}`);
  log(`Historique de suivi: ${walletHistory.length} wallet(s) suivis`);
  walletHistory.forEach((h, i) => {
    log(`  ${i + 1}. ${h.wallet} → ${h.switchedTo} (${h.reason})`);
  });

  currentWallet = newWallet;
  previousBalance = await getBalance(newWallet);
  log(
    `Nouveau wallet: ${newWallet} | Balance: ${(previousBalance / 1e9).toFixed(4)} SOL`
  );

  // Re-subscribe on WebSocket
  await resubscribe();
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

async function subscribeAccount(wallet) {
  try {
    const id = await wsSend({
      method: "accountSubscribe",
      params: [wallet, { encoding: "jsonParsed", commitment: CONFIG.COMMITMENT }],
    });
    log(`accountSubscribe envoyé (id=${id}) pour ${wallet.slice(0, 8)}...`);
    return id;
  } catch (e) {
    logWarn(`Erreur accountSubscribe: ${e.message}`);
    return null;
  }
}

async function subscribeLogs(wallet) {
  try {
    const id = await wsSend({
      method: "logsSubscribe",
      params: [
        { mentions: [wallet] },
        { commitment: CONFIG.COMMITMENT },
      ],
    });
    log(`logsSubscribe envoyé (id=${id}) pour ${wallet.slice(0, 8)}...`);
    return id;
  } catch (e) {
    logWarn(`Erreur logsSubscribe: ${e.message}`);
    return null;
  }
}

async function unsubscribeAll() {
  try {
    if (accountSubId !== null) {
      await wsSend({ method: "accountUnsubscribe", params: [accountSubId] });
      accountSubId = null;
    }
  } catch (_) {}
  try {
    if (logsSubId !== null) {
      await wsSend({ method: "logsUnsubscribe", params: [logsSubId] });
      logsSubId = null;
    }
  } catch (_) {}
}

async function resubscribe() {
  await unsubscribeAll();
  await subscribeAccount(currentWallet);
  await subscribeLogs(currentWallet);
}

// Track subscription IDs from server responses
const pendingSubscriptions = new Map();

async function handleWsMessage(data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }

  // Handle subscription confirmation
  if (msg.id && msg.result !== undefined) {
    if (typeof msg.result === "number") {
      // This is a subscription ID confirmation
      if (!accountSubId) {
        accountSubId = msg.result;
        logSuccess(`accountSubscribe confirmé (subId=${msg.result})`);
      } else if (!logsSubId) {
        logsSubId = msg.result;
        logSuccess(`logsSubscribe confirmé (subId=${msg.result})`);
      }
    }
    return;
  }

  // Handle notifications
  if (msg.method === "accountNotification") {
    await handleAccountNotification(msg.params);
  } else if (msg.method === "logsNotification") {
    await handleLogsNotification(msg.params);
  }
}

let isProcessing = false;

async function handleAccountNotification(params) {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const accountInfo = params?.result?.value;
    if (!accountInfo) return;

    const newBalance = accountInfo.lamports;
    const oldBalance = previousBalance;

    log(
      `Balance changée: ${(oldBalance / 1e9).toFixed(4)} → ${(newBalance / 1e9).toFixed(4)} SOL (${currentWallet.slice(0, 8)}...)`
    );

    // Check if balance dropped significantly (sent all SOL)
    if (oldBalance > 0 && newBalance < oldBalance) {
      const ratio = (oldBalance - newBalance) / oldBalance;

      if (ratio >= CONFIG.TRANSFER_THRESHOLD) {
        log("Transfert massif détecté! Analyse des transactions...");
        previousBalance = newBalance;
        await analyzeRecentTransactions();
        return;
      }
    }

    // Scan for token activity when balance decreases (spending SOL = potential token creation)
    if (newBalance < oldBalance) {
      await scanForTokenActivity();
    }

    previousBalance = newBalance;
  } catch (e) {
    logWarn(`Erreur handleAccountNotification: ${e.message}`);
  } finally {
    isProcessing = false;
  }
}

async function handleLogsNotification(params) {
  const result = params?.result;
  if (!result || !result.value) return;

  const { signature, logs } = result.value;
  if (!signature || !logs) return;

  // Check for real token creation patterns in logs
  const hasTokenCreation = logs.some(
    (l) =>
      MINT_LOG_PATTERNS.some((p) => l.includes(p)) ||
      Object.keys(KNOWN_LAUNCHPADS).some((p) => l.includes(p))
  );

  if (hasTokenCreation) {
    log(`Possible création de token détectée (sig: ${signature.slice(0, 16)}...)`);
    // Fetch full transaction for details
    try {
      // Small delay to let the transaction finalize
      await sleep(2000);
      const tx = await getTransaction(signature);
      if (tx) {
        reportTokenFindings(tx, currentWallet);
      }
    } catch (e) {
      logWarn(`Erreur analyse token: ${e.message}`);
    }
  }
}

function reportTokenFindings(tx, wallet) {
  const tokens = analyzeTransactionForTokenCreation(tx, wallet);
  if (tokens && tokens.length > 0) {
    for (const token of tokens) {
      if (token.type === "token_creation") {
        const launchpadInfo = token.launchpad
          ? `\n  Plateforme: ${token.launchpad}`
          : "";
        logAlert(
          `NOUVEAU TOKEN CREE!\n` +
          `  Adresse contrat (Mint): ${token.mintAddress}\n` +
          `  Programme: ${token.program}${launchpadInfo}\n` +
          `  Créateur: ${token.creator}\n` +
          `  Signature TX: ${token.signature}`
        );
      }
    }
  }
  return tokens;
}

// Track already-reported signatures to avoid duplicates
const reportedSignatures = new Set();

async function scanForTokenActivity() {
  try {
    const sigs = await getSignaturesForAddress(currentWallet, 3);
    if (!sigs || sigs.length === 0) return;

    for (const sigInfo of sigs) {
      if (sigInfo.err) continue;
      if (reportedSignatures.has(sigInfo.signature)) continue;

      const tx = await getTransaction(sigInfo.signature);
      if (!tx) continue;

      const tokens = reportTokenFindings(tx, currentWallet);
      if (tokens && tokens.length > 0) {
        reportedSignatures.add(sigInfo.signature);
      }
    }
  } catch (e) {
    logWarn(`Erreur scan token: ${e.message}`);
  }
}

async function analyzeRecentTransactions() {
  try {
    const sigs = await getSignaturesForAddress(currentWallet, 10);
    if (!sigs || sigs.length === 0) {
      log("Aucune transaction récente trouvée.");
      return;
    }

    for (const sigInfo of sigs) {
      if (sigInfo.err) continue;

      const tx = await getTransaction(sigInfo.signature);
      if (!tx) continue;

      // Check for token creation
      if (!reportedSignatures.has(sigInfo.signature)) {
        const tokens = reportTokenFindings(tx, currentWallet);
        if (tokens && tokens.length > 0) {
          reportedSignatures.add(sigInfo.signature);
        }
      }

      // Check for full SOL transfer
      const transfer = analyzeTransactionForTransfer(tx, currentWallet);
      if (transfer) {
        logAlert(
          `TRANSFERT TOTAL DETECTE!\n` +
          `  De: ${transfer.from}\n` +
          `  Vers: ${transfer.to}\n` +
          `  Montant: ${transfer.amountSOL.toFixed(4)} SOL (${(transfer.ratio * 100).toFixed(1)}% du solde)\n` +
          `  Signature TX: ${transfer.signature}`
        );

        // Clear reported sigs for new wallet
        reportedSignatures.clear();

        await switchToWallet(
          transfer.to,
          `Transfert de ${transfer.amountSOL.toFixed(4)} SOL (${(transfer.ratio * 100).toFixed(1)}%)`
        );
        return;
      }
    }

    log("Aucun transfert total trouvé dans les transactions récentes.");
  } catch (e) {
    logWarn(`Erreur analyse transactions: ${e.message}`);
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
    await subscribeAccount(currentWallet);
    await subscribeLogs(currentWallet);
  });

  ws.on("message", (data) => {
    handleWsMessage(data).catch((e) => {
      logWarn(`Erreur traitement message WS: ${e.message}`);
    });
  });

  ws.on("error", (err) => {
    logWarn(`Erreur WebSocket: ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    logWarn(`WebSocket fermé (code=${code}). Reconnexion dans ${CONFIG.RECONNECT_DELAY}ms...`);
    accountSubId = null;
    logsSubId = null;
    if (!isShuttingDown) {
      setTimeout(connectWebSocket, CONFIG.RECONNECT_DELAY);
    }
  });

  // Ping to keep alive
  const pingInterval = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30000);
}

// ─── Polling Fallback ───────────────────────────────────────────────────────

async function pollBalance() {
  if (isShuttingDown) return;

  try {
    const balance = await getBalance(currentWallet);
    const oldBalance = previousBalance;

    if (balance !== oldBalance) {
      log(
        `[Poll] Balance changée: ${(oldBalance / 1e9).toFixed(4)} → ${(balance / 1e9).toFixed(4)} SOL`
      );

      if (oldBalance > 0 && balance < oldBalance) {
        const ratio = (oldBalance - balance) / oldBalance;
        if (ratio >= CONFIG.TRANSFER_THRESHOLD) {
          log("[Poll] Transfert massif détecté! Analyse...");
          previousBalance = balance;
          await analyzeRecentTransactions();
          return;
        }
      }

      previousBalance = balance;
    }
  } catch (e) {
    logWarn(`[Poll] Erreur: ${e.message}`);
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function printBanner() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║          SOLANA WALLET TRACKER BOT                       ║
║          Powered by FluxRPC                              ║
╚══════════════════════════════════════════════════════════╝
`);
}

function printConfig() {
  log("Configuration:");
  log(`  RPC HTTP: ${CONFIG.RPC_HTTP}`);
  log(`  RPC WS:   ${CONFIG.RPC_WS}`);
  log(`  API Key:  ${CONFIG.API_KEY ? CONFIG.API_KEY.slice(0, 8) + "..." : "(aucune)"}`);
  log(`  Seuil transfert: ${(CONFIG.TRANSFER_THRESHOLD * 100).toFixed(0)}%`);
  log(`  Intervalle polling: ${CONFIG.POLL_INTERVAL}ms`);
  log(`  Commitment: ${CONFIG.COMMITMENT}`);
  console.log();
}

function printUsage() {
  console.log(`
Usage: node index.js <WALLET_ADDRESS>

  ou avec variables d'environnement:
    TRACK_WALLET=<address> node index.js

Variables d'environnement:
  FLUXRPC_API_KEY       - Clé API FluxRPC (requis)
  FLUXRPC_HTTP          - URL RPC HTTP (défaut: https://eu.fluxrpc.com)
  FLUXRPC_WS            - URL WebSocket (défaut: wss://ws.eu.fluxrpc.com)
  TRACK_WALLET          - Adresse du wallet à suivre
  TRANSFER_THRESHOLD    - Seuil de transfert (défaut: 0.95 = 95%)
  POLL_INTERVAL         - Intervalle de polling en ms (défaut: 5000)
  RECONNECT_DELAY       - Délai de reconnexion WS en ms (défaut: 3000)
  COMMITMENT            - Niveau de commitment (défaut: confirmed)

Exemple:
  FLUXRPC_API_KEY=your-key node index.js 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
`);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  printBanner();

  if (!CONFIG.INITIAL_WALLET) {
    printUsage();
    process.exit(1);
  }

  currentWallet = CONFIG.INITIAL_WALLET;
  printConfig();

  // Validate wallet address format (base58, 32-44 chars)
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(currentWallet)) {
    logWarn("L'adresse du wallet ne semble pas valide (format base58 attendu).");
    process.exit(1);
  }

  log(`Démarrage du suivi: ${currentWallet}`);

  // Get initial balance
  try {
    previousBalance = await getBalance(currentWallet);
    logSuccess(
      `Balance initiale: ${(previousBalance / 1e9).toFixed(4)} SOL`
    );
  } catch (e) {
    logWarn(`Impossible de récupérer la balance: ${e.message}`);
    logWarn("Vérifiez votre clé API et la connexion réseau.");
    process.exit(1);
  }

  // Connect WebSocket for real-time updates
  connectWebSocket();

  // Start polling as fallback
  log("Démarrage du polling de secours...");
  setInterval(pollBalance, CONFIG.POLL_INTERVAL);

  log("Bot en cours d'exécution. Appuyez sur Ctrl+C pour arrêter.\n");
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

process.on("SIGINT", () => {
  console.log();
  log("Arrêt du bot...");
  isShuttingDown = true;

  if (walletHistory.length > 0) {
    log("Historique de suivi:");
    walletHistory.forEach((h, i) => {
      log(`  ${i + 1}. ${h.wallet} → ${h.switchedTo} (${h.reason}) [${h.timestamp}]`);
    });
  }

  if (ws) {
    ws.close();
  }

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
