# Astrum Token Scraper — Extension Chrome

Extension Chrome qui récupère automatiquement toutes les informations d'un token depuis **Astrum.trade** : Health Index, Tradability, Dev Stats, Astrum Index, prix, liquidité, volume, holders, sécurité, et plus.

## Fonctionnement

L'extension utilise deux stratégies complémentaires pour capturer les données :

### 1. Interception réseau (API Scraping)
- **Fetch/XHR** : intercepte toutes les requêtes HTTP vers `*.astrum.trade` et capture les réponses JSON
- **WebSocket** : intercepte les messages WebSocket d'Astrum pour capturer les données temps réel (prix, trades, signaux)
- **webRequest** : monitore les requêtes réseau au niveau Chrome pour un suivi exhaustif

### 2. DOM Scraping
- **MutationObserver** : observe les changements du DOM en temps réel pour détecter l'apparition de données token
- **Pattern Matching** : identifie les champs de données (Health Index, Tradability, etc.) via des patterns textuels
- **Sites externes** : détecte le panneau overlay Astrum injecté sur Axiom, Photon, GMGN, DexScreener, Pump.fun, Twitter/X, Telegram Web

## Données capturées

| Catégorie | Champs |
|---|---|
| **Identité** | Adresse contrat, nom, symbole |
| **Scores Astrum** | Health Index, Tradability Score, Astrum Index, Dev Stats |
| **Marché** | Prix, Market Cap, Liquidité, Volume 24h |
| **Token Info** | Holders, Supply, Age, Buy/Sell Tax |
| **Sécurité** | LP Burned, Mint Authority, Freeze Authority, Bundled (Jito) |

## Installation

1. Ouvrir Chrome → `chrome://extensions/`
2. Activer le **Mode développeur** (toggle en haut à droite)
3. Cliquer **Charger l'extension non empaquetée**
4. Sélectionner le dossier `astrum-chrome-extension/`

## Utilisation

1. Installer l'extension
2. Naviguer sur **app.astrum.trade** ou un site supporté (Axiom, Photon, GMGN, etc.) avec l'extension Astrum active
3. Cliquer sur l'icône de l'extension dans la barre Chrome
4. Les données des tokens apparaissent automatiquement dans le popup

### Actions disponibles

- **Cliquer un token** → voir tous les détails dans une modale
- **Copier JSON** → copie les données brutes du token
- **Exporter** → télécharge toutes les données en fichier JSON
- **Onglet API Logs** → voir toutes les requêtes interceptées
- **Onglet Raw Data** → données brutes complètes

## Sites supportés

- `app.astrum.trade` (scraping direct + interception API)
- `axiom.trade` (détection panneau Astrum)
- `photon-sol.tinyastro.io`
- `gmgn.ai`
- `bullx.io`
- `dexscreener.com`
- `pump.fun`
- `twitter.com` / `x.com`
- `web.telegram.org`

## Architecture

```
astrum-chrome-extension/
├── manifest.json              # Manifest V3
├── js/
│   ├── background.js          # Service worker (stockage + routing)
│   ├── content.js             # Content script Astrum (DOM + API interception)
│   ├── content-external.js    # Content script sites externes (détection panneau)
│   └── popup.js               # Interface popup
├── css/
│   ├── popup.css              # Styles popup (dark theme)
│   └── content.css            # Styles badge indicateur
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── popup.html                 # Page popup
```

## Notes

- L'extension est **non-custodial** : elle ne touche pas à votre wallet et ne fait aucune transaction
- Les données sont stockées localement via `chrome.storage.local`
- L'extension nécessite que vous ayez accès à Astrum.trade (invitation requise)
- Compatible Chrome, Brave, Edge (tout navigateur Chromium)
