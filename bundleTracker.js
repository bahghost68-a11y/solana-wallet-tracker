// ─── Bundle Tracker Module ──────────────────────────────────────────────────
// Detects Pump.fun token launches and identifies Jito Bundle (Block 0 sniping).
// Analyzes block-level transaction ordering to detect bundled buys with Jito tips.
// ─── Constants ──────────────────────────────────────────────────────────────
const PUMPFUN_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const PUMPFUN_V2_PROGRAM_ID = "pumpkinfCnfqEjbTPAdw3XAhpbxU2sEgxRTmEJBGFP3";
const JITO_TIP_ACCOUNTS = new Set([
    "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
    "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
    "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
    "ADaUMid9yfUC67HyGE6jXlbVfyaUCQrdSQvBm7c1Yimj",
    "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
    "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
    "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
]);
const PUMPFUN_CREATE_PATTERNS = [
    "Program log: Instruction: Create",
    "Program log: Instruction: Initialize",
];
const WRAPPED_SOL = "So11111111111111111111111111111111111111112";
// ─── State ──────────────────────────────────────────────────────────────────
const processedSignatures = new Map();
const recentBundles = [];
const CACHE_TTL = 5 * 60 * 1000;
const MAX_RECENT_BUNDLES = 50;
let shared = null;
let backoffDelay = 100;
let enabled = process.env.BUNDLE_TRACKER !== "false";
// ─── Console Colors ─────────────────────────────────────────────────────────
const C = {
    RESET: "\x1b[0m",
    RED: "\x1b[31m",
    GREEN: "\x1b[32m",
    YELLOW: "\x1b[33m",
    CYAN: "\x1b[36m",
    MAGENTA: "\x1b[35m",
    BOLD: "\x1b[1m",
    DIM: "\x1b[2m",
    BG_RED: "\x1b[41m",
    BG_GREEN: "\x1b[42m",
    BG_YELLOW: "\x1b[43m",
};
// ─── Init ───────────────────────────────────────────────────────────────────
function init(resources) {
    shared = resources;
    setInterval(cleanCache, 60000);
}
function log(msg) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [BundleTracker]`;
    if (shared?.log)
        shared.log(`[BundleTracker] ${msg}`);
    else
        console.log(`${prefix} ${msg}`);
}
function logWarn(msg) {
    if (shared?.logWarn)
        shared.logWarn(`[BundleTracker] ${msg}`);
    else
        console.warn(`[BundleTracker] ⚠ ${msg}`);
}
// ─── Cache Management ───────────────────────────────────────────────────────
function cleanCache() {
    const now = Date.now();
    for (const [sig, ts] of processedSignatures) {
        if (now - ts > CACHE_TTL)
            processedSignatures.delete(sig);
    }
    while (recentBundles.length > MAX_RECENT_BUNDLES) {
        recentBundles.shift();
    }
}
// ─── Rate-Limited RPC ───────────────────────────────────────────────────────
async function rateLimitedRpcCall(method, params) {
    try {
        const result = await shared.rpcCall(method, params);
        backoffDelay = 100;
        return result;
    }
    catch (e) {
        if (e.message?.includes("429") || e.message?.includes("Too Many")) {
            backoffDelay = Math.min(backoffDelay * 2, 10000);
            logWarn(`Rate limited, backoff ${backoffDelay}ms`);
            await sleep(backoffDelay);
            return rateLimitedRpcCall(method, params);
        }
        throw e;
    }
}
// ─── Subscribe to Pump.fun Programs ─────────────────────────────────────────
async function subscribeToPumpFun() {
    if (!shared?.wsSend) {
        logWarn("WebSocket non disponible");
        return;
    }
    // Subscribe to Pump.fun v1
    try {
        if (shared.pendingSubQueue) {
            shared.pendingSubQueue.push({ address: PUMPFUN_PROGRAM_ID, type: "bundle_logs" });
        }
        await shared.wsSend({
            method: "logsSubscribe",
            params: [{ mentions: [PUMPFUN_PROGRAM_ID] }, { commitment: "confirmed" }],
        });
        log(`logsSubscribe envoyé pour Pump.fun v1`);
    }
    catch (e) {
        logWarn(`Erreur logsSubscribe Pump.fun v1: ${e.message}`);
    }
    // Subscribe to Pump.fun v2
    try {
        if (shared.pendingSubQueue) {
            shared.pendingSubQueue.push({ address: PUMPFUN_V2_PROGRAM_ID, type: "bundle_logs" });
        }
        await shared.wsSend({
            method: "logsSubscribe",
            params: [{ mentions: [PUMPFUN_V2_PROGRAM_ID] }, { commitment: "confirmed" }],
        });
        log(`logsSubscribe envoyé pour Pump.fun v2`);
    }
    catch (e) {
        logWarn(`Erreur logsSubscribe Pump.fun v2: ${e.message}`);
    }
}
// ─── Handle Log Notification ────────────────────────────────────────────────
async function handleLogNotification(signature, logs) {
    if (!signature || !logs)
        return;
    if (processedSignatures.has(signature))
        return;
    processedSignatures.set(signature, Date.now());
    const logText = logs.join("\n");
    // Only process token creation instructions
    const isCreation = PUMPFUN_CREATE_PATTERNS.some((p) => logText.includes(p));
    if (!isCreation)
        return;
    log(`Création Pump.fun détectée (sig: ${signature.slice(0, 20)}...)`);
    try {
        await sleep(2000);
        const analysis = await analyzeForJitoBundle(signature);
        if (analysis) {
            recentBundles.push(analysis);
            outputResult(analysis);
            await sendTelegramAlert(analysis);
        }
    }
    catch (e) {
        logWarn(`Erreur analyse bundle: ${e.message}`);
    }
}
// ─── Core: Jito Bundle Analysis ─────────────────────────────────────────────
async function analyzeForJitoBundle(creationSig) {
    // Step 1: Get the creation transaction
    const tx = await rateLimitedRpcCall("getTransaction", [
        creationSig,
        { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 },
    ]);
    if (!tx || !tx.meta || tx.meta.err)
        return null;
    const slot = tx.slot;
    const accountKeys = (tx.transaction?.message?.accountKeys || []).map((k) => typeof k === "string" ? k : k.pubkey);
    const creator = accountKeys[0] || "unknown";
    // Find the token mint from postTokenBalances
    let tokenMint = null;
    for (const tb of tx.meta.postTokenBalances || []) {
        if (tb.mint && tb.mint !== WRAPPED_SOL) {
            tokenMint = tb.mint;
            break;
        }
    }
    // Fallback: try from log messages
    if (!tokenMint) {
        for (const logLine of tx.meta.logMessages || []) {
            const match = logLine.match(/Mint:\s*([1-9A-HJ-NP-Za-km-z]{32,44})/);
            if (match) {
                tokenMint = match[1];
                break;
            }
        }
    }
    if (!tokenMint) {
        log(`Pas de mint trouvé pour ${creationSig.slice(0, 20)}...`);
        return null;
    }
    log(`Token: ${tokenMint} | Slot: ${slot} | Analyse du bloc...`);
    // Step 2: Get the full block
    let block;
    try {
        block = await rateLimitedRpcCall("getBlock", [
            slot,
            {
                encoding: "jsonParsed",
                transactionDetails: "full",
                rewards: false,
                maxSupportedTransactionVersion: 0,
            },
        ]);
    }
    catch (e) {
        logWarn(`Erreur getBlock slot=${slot}: ${e.message}`);
        return null;
    }
    if (!block || !block.transactions)
        return null;
    // Step 3: Find creation tx index in the block
    const txSignatures = block.transactions.map((t) => {
        const sigs = t.transaction?.signatures;
        return sigs ? sigs[0] : "";
    });
    const creationIndex = txSignatures.indexOf(creationSig);
    if (creationIndex === -1) {
        logWarn(`TX création non trouvée dans le bloc ${slot}`);
        return null;
    }
    log(`TX création à l'index ${creationIndex}/${txSignatures.length} dans le bloc`);
    // Step 4: Analyze sequential transactions for Jito bundle pattern
    const bundleSignatures = [];
    let totalJitoTipLamports = 0;
    let jitoTipAccount = "";
    let totalBoughtTokens = 0;
    // Check the creation tx itself for Jito tip
    const creationTipResult = detectJitoTip(block.transactions[creationIndex]);
    if (creationTipResult.tipLamports > 0) {
        totalJitoTipLamports += creationTipResult.tipLamports;
        jitoTipAccount = creationTipResult.tipAccount;
    }
    // Check transactions immediately after creation (up to 15 tx)
    for (let i = creationIndex + 1; i < Math.min(creationIndex + 16, block.transactions.length); i++) {
        const blockTx = block.transactions[i];
        if (!blockTx || !blockTx.meta || blockTx.meta.err)
            continue;
        const txMeta = blockTx.meta;
        const txMsg = blockTx.transaction?.message;
        if (!txMsg)
            continue;
        // Check if this transaction involves the same token
        const involvesToken = (txMeta.postTokenBalances || []).some((tb) => tb.mint === tokenMint);
        // Check for Jito tip
        const tipResult = detectJitoTip(blockTx);
        if (tipResult.tipLamports > 0) {
            totalJitoTipLamports += tipResult.tipLamports;
            if (!jitoTipAccount)
                jitoTipAccount = tipResult.tipAccount;
        }
        if (involvesToken) {
            bundleSignatures.push(txSignatures[i]);
            // Sum token amounts bought
            for (const tb of txMeta.postTokenBalances || []) {
                if (tb.mint === tokenMint) {
                    const amount = parseFloat(tb.uiTokenAmount?.uiAmountString || "0");
                    // Subtract pre-balance if exists
                    const preBalances = txMeta.preTokenBalances || [];
                    const preTb = preBalances.find((p) => p.mint === tokenMint && p.accountIndex === tb.accountIndex);
                    const preAmount = preTb
                        ? parseFloat(preTb.uiTokenAmount?.uiAmountString || "0")
                        : 0;
                    if (amount > preAmount) {
                        totalBoughtTokens += amount - preAmount;
                    }
                }
            }
        }
        // Stop if we hit a transaction that doesn't relate to bundle
        if (!involvesToken && tipResult.tipLamports === 0) {
            // Allow one gap (some bundles have non-related tx in between)
            const nextTx = block.transactions[i + 1];
            if (nextTx && nextTx.meta && !nextTx.meta.err) {
                const nextInvolvesToken = (nextTx.meta.postTokenBalances || []).some((tb) => tb.mint === tokenMint);
                if (!nextInvolvesToken)
                    break;
            }
            else {
                break;
            }
        }
    }
    // Step 5: Calculate supply percentage
    let supplyPercentage = 0;
    if (totalBoughtTokens > 0) {
        try {
            const supplyResult = await rateLimitedRpcCall("getTokenSupply", [
                tokenMint,
                { commitment: "confirmed" },
            ]);
            if (supplyResult?.value) {
                const totalSupply = parseFloat(supplyResult.value.uiAmountString || "0");
                if (totalSupply > 0) {
                    supplyPercentage = (totalBoughtTokens / totalSupply) * 100;
                }
            }
        }
        catch (e) {
            // Ignore supply errors
        }
    }
    const jitoTipSOL = totalJitoTipLamports / 1e9;
    const isBundle = bundleSignatures.length > 0 && jitoTipSOL > 0;
    return {
        isBundle,
        tokenMint,
        creationSignature: creationSig,
        creator,
        bundledBuys: bundleSignatures.length,
        supplyPercentage,
        jitoTipSOL,
        jitoTipAccount,
        bundleSignatures,
        slot,
        detectedAt: Date.now(),
    };
}
// ─── Jito Tip Detection in a Single Transaction ─────────────────────────────
function detectJitoTip(blockTx) {
    if (!blockTx || !blockTx.meta)
        return { tipLamports: 0, tipAccount: "" };
    const txMeta = blockTx.meta;
    const txMsg = blockTx.transaction?.message;
    if (!txMsg)
        return { tipLamports: 0, tipAccount: "" };
    const accountKeys = (txMsg.accountKeys || []).map((k) => typeof k === "string" ? k : k.pubkey);
    // Method 1: Check parsed instructions for SOL transfers to Jito accounts
    const allInstructions = [
        ...(txMsg.instructions || []),
        ...(txMeta.innerInstructions || []).flatMap((ii) => ii.instructions || []),
    ];
    for (const ix of allInstructions) {
        const parsed = ix.parsed;
        if (parsed && parsed.type === "transfer" && parsed.info) {
            const dest = parsed.info.destination;
            if (dest && JITO_TIP_ACCOUNTS.has(dest)) {
                return {
                    tipLamports: parsed.info.lamports || 0,
                    tipAccount: dest,
                };
            }
        }
    }
    // Method 2: Check pre/post balance diffs for Jito accounts
    for (let j = 0; j < accountKeys.length; j++) {
        if (JITO_TIP_ACCOUNTS.has(accountKeys[j])) {
            const pre = txMeta.preBalances?.[j] || 0;
            const post = txMeta.postBalances?.[j] || 0;
            if (post > pre) {
                return {
                    tipLamports: post - pre,
                    tipAccount: accountKeys[j],
                };
            }
        }
    }
    return { tipLamports: 0, tipAccount: "" };
}
// ─── Console Output with Colors ─────────────────────────────────────────────
function outputResult(analysis) {
    const now = new Date().toISOString();
    console.log(`\n${C.BOLD}${"═".repeat(70)}${C.RESET}`);
    console.log(`${C.CYAN}${C.BOLD}⏰ ${now}${C.RESET}`);
    console.log(`${C.BOLD}🪙 Token Mint: ${C.YELLOW}${analysis.tokenMint}${C.RESET}`);
    console.log(`${C.DIM}👤 Créateur: ${analysis.creator}${C.RESET}`);
    console.log(`${C.DIM}📦 Slot: ${analysis.slot}${C.RESET}`);
    if (analysis.isBundle) {
        console.log(`\n${C.BG_RED}${C.BOLD} 🚨 JITO BUNDLE DETECTED ${C.RESET}`);
        console.log(`${C.RED}${C.BOLD}   📦 Achats bundlés: ${analysis.bundledBuys}${C.RESET}`);
        if (analysis.supplyPercentage > 0) {
            console.log(`${C.RED}   📊 Supply acheté dans le bundle: ${analysis.supplyPercentage.toFixed(2)}%${C.RESET}`);
        }
        console.log(`${C.RED}   💰 Jito Tip: ${analysis.jitoTipSOL.toFixed(6)} SOL${C.RESET}`);
        console.log(`${C.RED}   🏦 Tip Account: ${analysis.jitoTipAccount.slice(0, 20)}...${C.RESET}`);
    }
    else {
        console.log(`\n${C.BG_GREEN}${C.BOLD} ✅ STANDARD LAUNCH ${C.RESET}`);
        if (analysis.bundledBuys > 0) {
            console.log(`${C.GREEN}   Achats dans le même bloc: ${analysis.bundledBuys} (pas de Jito tip détecté)${C.RESET}`);
        }
    }
    console.log(`${C.BOLD}${"═".repeat(70)}${C.RESET}\n`);
}
// ─── Telegram Alert ─────────────────────────────────────────────────────────
async function sendTelegramAlert(analysis) {
    if (!shared?.sendTelegram)
        return;
    let msg;
    if (analysis.isBundle) {
        msg =
            `🚨 <b>JITO BUNDLE DETECTE!</b>\n\n` +
                `🪙 Token: <code>${analysis.tokenMint}</code>\n` +
                `👤 Créateur: <code>${analysis.creator.slice(0, 16)}...</code>\n` +
                `📦 Slot: ${analysis.slot}\n` +
                `🛒 Achats bundlés: ${analysis.bundledBuys}\n` +
                (analysis.supplyPercentage > 0
                    ? `📊 Supply acheté: ${analysis.supplyPercentage.toFixed(2)}%\n`
                    : "") +
                `💰 Jito Tip: ${analysis.jitoTipSOL.toFixed(6)} SOL\n` +
                `🔗 TX: <code>${analysis.creationSignature.slice(0, 32)}...</code>\n\n` +
                `⚠️ <i>Block 0 sniping — le dev a bundlé ses achats avec la création</i>`;
    }
    else {
        msg =
            `✅ <b>LANCEMENT PUMP.FUN STANDARD</b>\n\n` +
                `🪙 Token: <code>${analysis.tokenMint}</code>\n` +
                `👤 Créateur: <code>${analysis.creator.slice(0, 16)}...</code>\n` +
                `📦 Slot: ${analysis.slot}\n` +
                `🔗 TX: <code>${analysis.creationSignature.slice(0, 32)}...</code>`;
    }
    await shared.sendTelegram(msg);
}
// ─── Telegram Command Handler ───────────────────────────────────────────────
async function handleCommand(command, parts, chatId) {
    switch (command) {
        case "/bundles": {
            const bundled = recentBundles.filter((b) => b.isBundle);
            if (bundled.length === 0) {
                if (shared?.sendTelegram) {
                    await shared.sendTelegram("📋 Aucun Jito Bundle détecté récemment.", chatId);
                }
                return true;
            }
            const recent = bundled.slice(-10).reverse();
            let msg = `🚨 <b>Jito Bundles récents (${bundled.length} total):</b>\n\n`;
            for (const b of recent) {
                const age = ((Date.now() - b.detectedAt) / 1000).toFixed(0);
                msg +=
                    `🪙 <code>${b.tokenMint.slice(0, 16)}...</code>\n` +
                        `   📦 ${b.bundledBuys} achats | 💰 ${b.jitoTipSOL.toFixed(4)} SOL tip\n` +
                        (b.supplyPercentage > 0
                            ? `   📊 ${b.supplyPercentage.toFixed(1)}% supply | `
                            : "   ") +
                        `⏱ il y a ${age}s\n\n`;
            }
            if (shared?.sendTelegram)
                await shared.sendTelegram(msg, chatId);
            return true;
        }
        case "/bundle": {
            const totalDetected = recentBundles.length;
            const totalBundled = recentBundles.filter((b) => b.isBundle).length;
            const totalStandard = totalDetected - totalBundled;
            const msg = `📊 <b>Bundle Tracker Config</b>\n\n` +
                `${enabled ? "✅" : "❌"} Activé\n` +
                `🎯 Programme: Pump.fun (v1 + v2)\n` +
                `📡 Détection: Jito Bundle (Block 0 sniping)\n` +
                `🔍 Lancements analysés: ${totalDetected}\n` +
                `🚨 Bundles détectés: ${totalBundled}\n` +
                `✅ Lancements standard: ${totalStandard}\n` +
                `🧹 Cache: ${processedSignatures.size} signatures`;
            if (shared?.sendTelegram)
                await shared.sendTelegram(msg, chatId);
            return true;
        }
        case "/analyze": {
            const sig = parts[1];
            if (!sig) {
                if (shared?.sendTelegram) {
                    await shared.sendTelegram("❌ Usage: /analyze <code>&lt;tx_signature&gt;</code>", chatId);
                }
                return true;
            }
            if (shared?.sendTelegram) {
                await shared.sendTelegram("🔍 Analyse en cours...", chatId);
            }
            try {
                const analysis = await analyzeForJitoBundle(sig);
                if (analysis) {
                    recentBundles.push(analysis);
                    outputResult(analysis);
                    await sendTelegramAlert(analysis);
                }
                else {
                    if (shared?.sendTelegram) {
                        await shared.sendTelegram("❌ Impossible d'analyser cette transaction (pas une création Pump.fun ou TX non trouvée)", chatId);
                    }
                }
            }
            catch (e) {
                if (shared?.sendTelegram) {
                    await shared.sendTelegram(`❌ Erreur: ${e.message}`, chatId);
                }
            }
            return true;
        }
        default:
            return false;
    }
}
// ─── Utility ────────────────────────────────────────────────────────────────
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
// ─── Exports ────────────────────────────────────────────────────────────────
module.exports = {
    init,
    subscribeToPumpFun,
    handleLogNotification,
    handleCommand,
    PUMPFUN_PROGRAM_ID,
    PUMPFUN_V2_PROGRAM_ID,
    JITO_TIP_ACCOUNTS,
    recentBundles,
    enabled,
};
