# Solana Wallet Tracker Bot

Bot de suivi automatique de wallets Solana avec détection de création de tokens, conçu pour **Termux** et alimenté par l'API **FluxRPC**.

## Fonctionnalités

- **Suivi en temps réel** via WebSocket (accountSubscribe + logsSubscribe)
- **Chain-following automatique** : quand un wallet envoie la totalité de ses SOL à un nouveau wallet, le bot suit automatiquement le nouveau wallet
- **Détection de création de tokens** : si le wallet crée un token (SPL Token ou Token-2022), le bot affiche l'adresse du contrat (mint address)
- **Polling de secours** : en cas de déconnexion WebSocket, un polling HTTP prend le relais
- **Reconnexion automatique** : le bot se reconnecte automatiquement en cas de coupure
- **Historique de suivi** : garde un historique de tous les wallets suivis

## Prérequis

- Node.js 16+ (ou 18+ recommandé)
- Une clé API FluxRPC (gratuite sur [fluxrpc.com](https://fluxrpc.com))

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

## Installation classique (Linux/Mac/Windows)

```bash
git clone https://github.com/bahghost68-a11y/solana-wallet-tracker.git
cd solana-wallet-tracker
npm install
```

## Configuration

Créez un fichier `.env` ou exportez les variables d'environnement :

```bash
export FLUXRPC_API_KEY="votre-clé-api"
export TRACK_WALLET="adresse-du-wallet-à-suivre"
```

### Variables d'environnement

| Variable | Description | Défaut |
|---|---|---|
| `FLUXRPC_API_KEY` | Clé API FluxRPC (requise) | - |
| `FLUXRPC_HTTP` | URL du RPC HTTP | `https://eu.fluxrpc.com` |
| `FLUXRPC_WS` | URL du WebSocket | `wss://ws.eu.fluxrpc.com` |
| `TRACK_WALLET` | Adresse du wallet initial | - |
| `TRANSFER_THRESHOLD` | Seuil pour considérer un transfert comme "total" (0.0-1.0) | `0.95` (95%) |
| `POLL_INTERVAL` | Intervalle de polling de secours (ms) | `5000` |
| `RECONNECT_DELAY` | Délai de reconnexion WebSocket (ms) | `3000` |
| `COMMITMENT` | Niveau de commitment Solana | `confirmed` |

## Utilisation

```bash
# Avec argument en ligne de commande
FLUXRPC_API_KEY=votre-clé node index.js <ADRESSE_WALLET>

# Avec variables d'environnement
export FLUXRPC_API_KEY="votre-clé"
export TRACK_WALLET="7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU"
node index.js

# Ou avec npm
npm start -- <ADRESSE_WALLET>
```

## Comment ça marche

```
┌────────────────────────────────────────────────────────┐
│                    DEMARRAGE                            │
│  → Récupère la balance du wallet initial               │
│  → Se connecte au WebSocket FluxRPC                    │
│  → S'abonne aux changements du wallet                  │
└──────────────────────┬─────────────────────────────────┘
                       │
                       ▼
┌────────────────────────────────────────────────────────┐
│                  SURVEILLANCE                           │
│  WebSocket: accountSubscribe + logsSubscribe            │
│  Polling:   getBalance toutes les 5s (secours)          │
└──────────┬──────────────────────────────┬──────────────┘
           │                              │
           ▼                              ▼
┌─────────────────────────┐  ┌───────────────────────────┐
│  BALANCE CHANGE          │  │  LOG: InitializeMint       │
│  Si >95% envoyé:         │  │  → Récupère la TX          │
│  → Analyse les TX        │  │  → Extrait mint address    │
│  → Trouve le destinataire│  │  → ALERTE: TOKEN CREE!     │
│  → SWITCH wallet         │  │                            │
│  → Recommence            │  │                            │
└─────────────────────────┘  └───────────────────────────┘
```

## Exemple de sortie

```
╔══════════════════════════════════════════════════════════╗
║          SOLANA WALLET TRACKER BOT                       ║
║          Powered by FluxRPC                              ║
╚══════════════════════════════════════════════════════════╝

[2025-01-15T10:30:00.000Z] Configuration:
[2025-01-15T10:30:00.000Z]   RPC HTTP: https://eu.fluxrpc.com
[2025-01-15T10:30:00.000Z]   RPC WS:   wss://ws.eu.fluxrpc.com
[2025-01-15T10:30:00.000Z] ✓ Balance initiale: 5.2300 SOL
[2025-01-15T10:30:00.000Z] ✓ WebSocket connecté!
[2025-01-15T10:30:00.000Z] ✓ accountSubscribe confirmé
[2025-01-15T10:30:00.000Z] ✓ logsSubscribe confirmé

[2025-01-15T10:35:22.000Z] Balance changée: 5.2300 → 0.0010 SOL
[2025-01-15T10:35:22.000Z] Transfert massif détecté! Analyse...

============================================================
[2025-01-15T10:35:23.000Z] 🚨 TRANSFERT TOTAL DETECTE!
  De: 7xKXtg2C...gAsU
  Vers: 9aBcDeF1...xYzW
  Montant: 5.2290 SOL (99.8%)
  Signature TX: 4vJ9...abc
============================================================

============================================================
[2025-01-15T10:35:23.000Z] 🚨 SWITCH WALLET: 7xKXtg2C...gAsU → 9aBcDeF1...xYzW
============================================================

[2025-01-15T10:40:15.000Z] Possible création de token détectée...

============================================================
[2025-01-15T10:40:16.000Z] 🚨 TOKEN CREE!
  Adresse contrat (Mint): TokenMintAddress123...
  Programme: SPL Token
  Créateur: 9aBcDeF1...xYzW
  Signature TX: 5wK8...def
============================================================
```

## Licence

MIT
