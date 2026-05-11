# Solana Wallet Tracker Bot

Bot de suivi automatique de wallets Solana avec **Telegram**, détection de création de tokens, multi-wallet, et **Entry Tracker** (détection de nouveaux pools + sniping). Conçu pour **Termux**, alimenté par **FluxRPC**.

## Fonctionnalités

- **Multi-wallet** : suivre plusieurs wallets simultanément
- **Telegram intégré** : recevoir toutes les alertes sur Telegram + gérer les wallets via commandes
- **Suivi en temps réel** via WebSocket (accountSubscribe + logsSubscribe)
- **Chain-following automatique** : quand un wallet envoie la totalité de ses SOL → suit automatiquement le nouveau wallet
- **Détection de création de tokens** : si le wallet crée un token, envoie l'adresse contrat (mint address) sur Telegram
- **Persistance** : les wallets suivis sont sauvegardés et restaurés au redémarrage
- **Polling de secours** : en cas de déconnexion WebSocket, un polling HTTP prend le relais
- **Reconnexion automatique**

### Entry Tracker (Sniping)

- **Détection de nouveaux pools** Raydium AMM et Pump.fun via `logsSubscribe`
- **Rolling Window** : surveille les transactions d'achat — si >50 acheteurs uniques en <10 secondes, déclenche un événement **VolumeSpike**
- **Vérification de sécurité** : vérifie que le Mint Authority est null (pas de création infinie) et que les LP tokens sont brûlés
- **Signal d'achat** avec slippage dynamique (ajusté selon le volume et l'âge du pool)
- **Commandes Telegram** : `/pools`, `/check`, `/entry`

### Bundle Tracker (Jito Detection)

- **Détection en temps réel** des lancements Pump.fun via `logsSubscribe`
- **Analyse de bloc** : vérifie si la transaction de création est incluse dans un **Jito Bundle** (Block 0 sniping)
- **Détection Jito** : identifie les transactions séquentielles + paiements aux Jito Tip Accounts
- **Calcul** du pourcentage de supply acheté dans le bundle et du montant du Tip
- **Output console coloré** : `[STANDARD LAUNCH]` ou `🚨 [JITO BUNDLE DETECTED]`
- **Cache avec TTL** (5 min) + backoff algorithmique sur rate limiting
- **Commandes Telegram** : `/bundle`, `/bundles`, `/analyze`

## Commandes Telegram

| Commande | Description |
|---|---|
| `/start` | Démarre le bot et affiche l'aide |
| `/add <adresse> [label]` | Ajouter un wallet à suivre |
| `/remove <adresse>` | Supprimer un wallet |
| `/list` | Voir tous les wallets suivis avec leurs balances |
| `/status` | État du bot (WebSocket, uptime, etc.) |
| `/help` | Afficher l'aide |
| `/pools` | Pools détectés récemment (Entry Tracker) |
| `/check <mint>` | Vérifier la sécurité d'un token (Mint Authority) |
| `/entry` | Configuration de l'Entry Tracker |
| `/bundle` | Stats du Bundle Tracker (Jito) |
| `/bundles` | Jito Bundles détectés récemment |
| `/analyze <tx_sig>` | Analyser une TX manuellement pour Jito bundle |

## Prérequis

- Node.js 16+ (18+ recommandé)
- Une clé API FluxRPC (gratuite sur [fluxrpc.com](https://fluxrpc.com))
- Un bot Telegram (créé via [@BotFather](https://t.me/BotFather))

## Installation sur Termux

```bash
# Installer Node.js
pkg update && pkg upgrade
pkg install nodejs

# Cloner le projet
git clone https://github.com/bahghost68-a11y/solana-wallet-tracker.git
cd solana-wallet-tracker

# Installer les dépendances
npm install
```

## Configuration Telegram

1. Ouvrez Telegram et cherchez **@BotFather**
2. Envoyez `/newbot` et suivez les instructions
3. Copiez le **token** du bot (ex: `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`)
4. Envoyez `/start` à votre nouveau bot pour obtenir le chat ID automatiquement

## Variables d'environnement

| Variable | Description | Défaut |
|---|---|---|
| `FLUXRPC_API_KEY` | Clé API FluxRPC (requise) | - |
| `TELEGRAM_BOT_TOKEN` | Token du bot Telegram | - |
| `TELEGRAM_CHAT_ID` | ID du chat (auto-détecté) | - |
| `FLUXRPC_HTTP` | URL du RPC HTTP | `https://eu.fluxrpc.com` |
| `FLUXRPC_WS` | URL du WebSocket | `wss://ws.eu.fluxrpc.com` |
| `TRANSFER_THRESHOLD` | Seuil transfert total (0.0-1.0) | `0.95` |
| `POLL_INTERVAL` | Intervalle polling (ms) | `5000` |
| `RECONNECT_DELAY` | Délai reconnexion WebSocket (ms) | `3000` |
| `COMMITMENT` | Commitment Solana | `confirmed` |
| `ENTRY_TRACKER` | Activer l'entry tracker | `true` |
| `VOLUME_THRESHOLD` | Acheteurs uniques pour VolumeSpike | `50` |
| `VOLUME_WINDOW_MS` | Fenêtre glissante (ms) | `10000` |
| `BUY_AMOUNT_SOL` | Montant d'achat par signal | `0.1` |
| `AUTO_BUY` | Auto-achat activé | `false` |
| `BASE_SLIPPAGE_BPS` | Slippage de base (bps) | `500` |
| `MAX_SLIPPAGE_BPS` | Slippage maximum (bps) | `3000` |
| `BUNDLE_TRACKER` | Activer le bundle tracker Jito | `true` |

## Utilisation

### Avec Telegram (recommandé)

```bash
# Démarrer le bot - ajouter les wallets via Telegram ensuite
FLUXRPC_API_KEY=votre-clé TELEGRAM_BOT_TOKEN=votre-token node index.js

# Ou avec des wallets initiaux en CLI
FLUXRPC_API_KEY=votre-clé TELEGRAM_BOT_TOKEN=votre-token node index.js wallet1 wallet2
```

Puis sur Telegram, envoyez `/start` au bot et utilisez `/add` pour ajouter des wallets.

### Sans Telegram (console uniquement)

```bash
FLUXRPC_API_KEY=votre-clé node index.js wallet1 wallet2
```

### Avec fichier .env

```bash
cp .env.example .env
# Éditez .env avec vos clés
node index.js
```

## Comment ça marche

```
┌─────────────────────────────────────────────────────────┐
│                    DEMARRAGE                             │
│  → Charge les wallets sauvegardés (wallets.json)        │
│  → Se connecte au WebSocket FluxRPC                     │
│  → Démarre le polling Telegram                          │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              SURVEILLANCE (multi-wallet)                 │
│  WebSocket: accountSubscribe + logsSubscribe par wallet  │
│  Polling:   getBalance toutes les 5s (secours)          │
│  Telegram:  écoute les commandes /add /remove /list     │
└──────────┬──────────────────────────────┬───────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────────┐  ┌────────────────────────────┐
│  BALANCE DIMINUE         │  │  LOG: InitializeMint        │
│  Si ≥95% envoyé:        │  │  → Récupère la TX           │
│  → Analyse les TX       │  │  → Extrait mint address     │
│  → Trouve destinataire  │  │  → TELEGRAM: TOKEN CREE!    │
│  → SWITCH wallet        │  │                             │
│  → Telegram notifie     │  │                             │
└─────────────────────────┘  └────────────────────────────┘
```

## Alertes Telegram

Le bot envoie des notifications pour :
- 🪙 **Token créé** — avec l'adresse contrat (mint), la plateforme (pump.fun, Raydium, etc.)
- 💸 **Transfert total** — quand un wallet envoie ≥95% de ses SOL
- 🔄 **Switch wallet** — quand le bot commence à suivre un nouveau wallet
- 🟢 **Bot démarré** / 🔴 **Bot arrêté**
- 🆕 **Nouveau pool détecté** — Raydium ou Pump.fun avec adresse du token
- 🔥 **Volume Spike** — quand >50 acheteurs uniques en <10s
- 🛭 **Signal d'achat** — si la sécurité est OK (Mint Authority null + LP brûlé)
- ⚠️ **Alerte sécurité** — si le token échoue les vérifications
- 🚨 **Jito Bundle détecté** — Block 0 sniping avec détails (supply %, tip SOL)
- ✅ **Lancement standard** — création Pump.fun sans bundle

## Déploiement sur Railway (24/7)

### 1. Créer un projet Railway

1. Allez sur [railway.app](https://railway.app) et connectez votre compte GitHub
2. Cliquez **"New Project"** → **"Deploy from GitHub Repo"**
3. Sélectionnez le repo `solana-wallet-tracker`
4. Railway détecte automatiquement Node.js

### 2. Configurer les variables d'environnement

Dans les **Settings** du service, ajoutez ces variables :

| Variable | Valeur |
|---|---|
| `FLUXRPC_API_KEY` | Votre clé API FluxRPC |
| `TELEGRAM_BOT_TOKEN` | Token de votre bot Telegram |
| `TELEGRAM_CHAT_ID` | Votre chat ID Telegram |

### 3. Vérifier le déploiement

- Railway va installer les dépendances et lancer `node index.js` automatiquement (via le `Procfile`)
- Le bot utilise un **worker** (pas un serveur web), il n'a pas besoin de port
- Vérifiez les logs dans Railway pour confirmer que le bot est connecté
- Envoyez `/status` au bot Telegram pour vérifier qu'il tourne

### 4. Gestion

- Les wallets sont gérés via Telegram (`/add`, `/remove`, `/list`)
- Le fichier `wallets.json` est recréé au redémarrage — les wallets ajoutés via Telegram sont persistés tant que le service tourne
- Pour un redémarrage, ré-ajoutez vos wallets via `/add` (ou utilisez les variables d'env pour passer des wallets en CLI)

## Licence

MIT
