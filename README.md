# Freebox Monitor (Docker)

Version web et serveur de l'appli Android [freebox-monitor](https://github.com/jhenninot/freebox-monitor) :
un conteneur qui tourne en permanence à côté de la Freebox, garde l'historique et prévient quand quelque chose change.

```
Freebox ──API locale──> freebox-monitor (Node + Express + SQLite) ──> interface web (Vue 3)
                                   │                                └─> alertes ntfy sur le téléphone
                                   └── volume Docker : base + sauvegardes
```

## Fonctionnalités (lot 1)

**Accueil**
- Connexion Internet : état, type (fibre, ADSL, 4G), débits en direct et maximum, IP publiques, volumes échangés
- Freebox Server : modèle, firmware, durée depuis le démarrage, températures, ventilateurs
- Courbe des débits en direct, sur 1 h, 24 h, 7 j, 30 j ou 1 an (mesurée par le serveur toutes les 10 s, gardée en moyennes)

**Appareils**
- Liste avec recherche (nom, IP, MAC, fabricant), filtres (en ligne, hors ligne, surveillés), tri (nom, IP, activité, fabricant)
- Étoile pour surveiller un appareil, appareils masqués en bas de liste
- Fiche : détails, renommage dans la Freebox, **historique de présence** (arrivées, départs, part du temps en ligne sur 1, 7 ou 30 jours)

**Journal et alertes**
- Nouvel appareil sur le réseau, appareil surveillé hors ligne (délai réglable) puis de retour
- Coupure et retour de la connexion Internet, changement d'IPv4 publique, redémarrage de la box
- Tout est inscrit au journal ; envoi sur le téléphone par [ntfy](https://ntfy.sh) si configuré

**Sécurité**
- Interface protégée par mot de passe (cookie de session signé, 10 essais par quart d'heure)
- Jeton Freebox chiffré en AES-256-GCM dans la base avec `APP_SECRET`

## Installation dans Dockhand

1. **Secret** : générer une chaîne aléatoire, par exemple `openssl rand -hex 32`. Elle chiffre le jeton Freebox :
   si elle change, il faudra refaire l'association.
2. **Accès à l'image** : elle est publiée par la CI sur `ghcr.io/jhenninot/freebox-monitor-docker`. Si le paquet est privé,
   ajouter le registre `ghcr.io` dans Dockhand (login GitHub + jeton avec le droit `read:packages`, le même que pour le relais).
3. **Créer la stack** `freebox-monitor` : coller le [`docker-compose.yml`](docker-compose.yml) et renseigner les variables :

   | Variable | Valeur |
   | --- | --- |
   | `APP_SECRET` | le secret de l'étape 1 |
   | `ADMIN_PASSWORD` | le mot de passe de l'interface (8 caractères minimum) |
   | `FREEBOX_URL` | facultatif, `http://mafreebox.freebox.fr` par défaut (ou `http://192.168.1.254`) |
   | `NTFY_URL`, `NTFY_TOPIC` | facultatif, par exemple `https://ntfy.sh` et un sujet difficile à deviner |
   | `NTFY_TOKEN` | facultatif, jeton d'accès si le sujet ntfy est protégé |

4. Démarrer la stack : les logs affichent « Freebox Monitor … prêt sur le port 8080 ».
5. Ouvrir `http://<serveur-docker>:8086`, se connecter, cliquer sur **Associer** et valider sur l'écran du Freebox Server.
6. Pour pouvoir **renommer** des appareils : dans Freebox OS, *Paramètres de la Freebox > Gestion des accès > Applications*,
   éditer « Freebox Monitor (serveur) » et cocher **Modification des réglages de la Freebox**.

La première vérification des appareils mémorise ceux qui sont présents sans alerter. Les suivantes signalent les nouveaux.

### Réseau

Le mode bridge par défaut suffit : le conteneur joint la Freebox et le réseau local par le NAT de Docker.
Si `mafreebox.freebox.fr` ne se résout pas depuis le conteneur, mettre l'IP de la box dans `FREEBOX_URL`.

### Nginx Proxy Manager

L'appli peut modifier la box : il vaut mieux la garder accessible **uniquement en local et via le VPN de la Freebox**.
Pour l'exposer par NPM quand même : Proxy Host vers `http://<serveur-docker>:8086`, certificat Let's Encrypt
et une **Access List** limitée au réseau local. Le flux temps réel (Server-Sent Events) désactive lui-même la mise en tampon de Nginx.

### Sauvegardes

Une copie de la base est faite chaque jour dans le volume (`/data/backup/freebox-monitor-AAAA-MM-JJ.db`, 7 jours gardés).

## Conservation des données

| Données | Durée | Variable |
| --- | --- | --- |
| Mesures brutes (toutes les 10 à 60 s) | 7 jours | `RETENTION_RAW_DAYS` |
| Moyennes à la minute | 90 jours | `RETENTION_MINUTE_DAYS` |
| Moyennes à l'heure | sans limite | |
| Journal | 365 jours | `RETENTION_EVENT_DAYS` |

Fréquences de collecte : `POLL_CONNECTION_SECONDS` (10), `POLL_DEVICES_SECONDS` (30), `POLL_SYSTEM_SECONDS` (60).

## Développer

Node 22.13 ou plus récent (la base utilise le module `node:sqlite` intégré à Node, sans dépendance native).

```bash
# Serveur
cd server && npm install
npm test                       # tests (avec une fausse Freebox)
npm run fake-freebox           # fausse Freebox sur le port 8090, pour essayer sans box
APP_SECRET=dev-secret-assez-long ADMIN_PASSWORD=motdepasse FREEBOX_URL=http://127.0.0.1:8090 \
  DATA_DIR=./data npm run dev  # API sur http://localhost:8080

# Interface (autre terminal)
cd web && npm install
npm run dev                    # http://localhost:5173, relaie /api vers le port 8080
```

Le développement se fait directement sur `main` : chaque push lance les tests, construit l'interface
et publie l'image `ghcr.io/jhenninot/freebox-monitor-docker:latest`. Dans Dockhand, relancer la stack en
récupérant la nouvelle image.

## Organisation du code

```
server/src/
├── index.js          démarrage, chiffrement du jeton, sauvegarde quotidienne
├── config.js         variables d'environnement
├── app.js            API REST + flux temps réel (SSE) + fichiers de l'interface
├── collector.js      collecte périodique, journal, envoi des alertes
├── alerts.js         règles des alertes (traduites de l'appli Android) et envoi ntfy
├── db.js             SQLite : schéma, migrations, agrégats, conservation
├── security.js       HMAC Freebox, AES-GCM, cookies signés
└── freebox/          client de l'API Freebox OS (association, session) et conversions
web/src/
├── views/            Accueil, Appareils, fiche appareil, Journal, Association, Connexion
├── components/       courbe des débits (Chart.js)
└── api.js, live.js   appels à l'API et état temps réel
```

## Prochaines étapes

- **Lot 2** : IP fixes, redirections de ports, VPN (repris de l'appli Android), ping et qualité Internet (latence, perte),
  surveillance des services (Home Assistant, NPM, Mealie, Proxmox), scans de ports planifiés,
  notifications poussées par la box (`notif/targets`)
- **Lot 3** : test de débit planifié, Wi-Fi par appareil, rapport mensuel, capteurs MQTT pour Home Assistant
