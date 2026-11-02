# Freebox Monitor (Docker)

Version web et serveur de l'appli Android [freebox-monitor](https://github.com/jhenninot/freebox-monitor) :
un conteneur qui tourne en permanence à côté de la Freebox, garde l'historique et prévient quand quelque chose change.

```
Freebox ──API locale──> freebox-monitor (Node + Express + SQLite) ──> interface web (Vue 3)
                                   │                                └─> alertes ntfy sur le téléphone
                                   └── volume Docker : base + sauvegardes
```

## Fonctionnalités

**Accueil**
- Connexion Internet : état, type (fibre, ADSL, 4G), débits en direct et maximum, IP publiques, volumes échangés,
  signal fibre et puissances optiques reçue / émise (en dBm, historisées)
- Freebox Server : modèle, firmware, durée depuis le démarrage, températures, ventilateurs
- Courbe des débits en direct, sur 1 h, 24 h, 7 j, 30 j ou 1 an (mesurée par le serveur toutes les 10 s, gardée en moyennes)
- Trafic par appareil, trié par débit actuel ou par volume : stations Wi-Fi et prises Ethernet
  (plusieurs appareils derrière une même prise ne peuvent pas être départagés)
- Bandeau « température élevée » à partir de 85 °C

**Appareils**
- Liste avec recherche (nom, IP, MAC, fabricant), filtres (en ligne, hors ligne, surveillés), tri (nom, IP, activité, fabricant)
- Étoile pour surveiller un appareil, appareils masqués en bas de liste
- Fiche : détails, **historique de présence** (arrivées, départs, part du temps en ligne sur 1, 7 ou 30 jours),
  trafic actuel et courbe sur 1 h, 24 h ou 7 j
- Dans la box depuis la fiche : renommer, changer le type, nom local (`proxmox.home.arpa`, API 16), fixer l'IP,
  réveil Wake-on-LAN, bloquer / débloquer en Wi-Fi (liste noire du filtrage MAC), oublier l'appareil
- Infos détectées par la box : autres noms, IPv6, UPnP, mDNS, DHCP
- **Scan de ports** fait par le serveur : rapide (~150 ports courants) ou complet (1 à 65535), service et bannière
  lus sur chaque port (version SSH, titre de la page web, MySQL…), lien vers les pages web, comparaison avec le scan précédent
- Punaise 📌 sur les appareils qui ont une IP fixe

**Réseau**
- IP fixes : liste, ajout, modification, suppression, « Fixer » une adresse distribuée automatiquement,
  rappel des appareils surveillés sans IP fixe
- Redirections de ports : liste, ajout (plages, IP source), modification, activation, suppression, avec les
  avertissements de l'appli Android (port déjà pris par la box ou une autre redirection, destination sans IP fixe,
  IPv4 partagée) ; état de la DMZ et ports utilisés par les services de la box
- Serveur VPN : démarrer / arrêter WireGuard, OpenVPN, IPsec, PPTP, port, MTU, chiffrement ; connexions en cours
  (déconnecter) ; accès (création, IP réservée, mot de passe) ; fichier de configuration et QR code WireGuard
- Client VPN de la box : import d'un fichier .conf WireGuard ou réglages PPTP, activation, état, débit, journal
- Notifications de la box : le serveur s'inscrit comme destinataire auprès de la Freebox (API 11) ; nouvel appareil,
  redémarrage, mot de passe changé, appel manqué… arrivent dans le journal et par ntfy. La box appelle
  `<adresse>/box-notif/<secret>` : une IP locale en http suffit, pas besoin d'exposer le serveur sur Internet
- Filtrage Wi-Fi : mode (désactivé, liste blanche, liste noire), listes, ajout depuis les appareils connus ;
  avant d'activer la liste blanche, ajout proposé des appareils connectés en Wi-Fi et de celui depuis lequel tu consultes

**Journal et alertes**
- Nouvel appareil sur le réseau, appareil surveillé hors ligne (délai réglable) puis de retour
- Coupure et retour de la connexion Internet, changement d'IPv4 publique, redémarrage de la box
- Port qui s'ouvre sur un appareil surveillé : scan rapide chaque nuit (heure réglable dans le Journal),
  comparé au scan précédent
- Température élevée dans la box (seuil `TEMP_ALERT_CELSIUS`, 85 °C par défaut), puis retour à la normale 5 °C en dessous
- Tout est inscrit au journal ; envoi sur le téléphone par [ntfy](https://ntfy.sh) si configuré

**Sécurité**
- Interface protégée par mot de passe (cookie de session signé, 10 essais par quart d'heure)
- Jeton Freebox chiffré en AES-256-GCM dans la base avec `APP_SECRET`

## Installation dans Dockhand

> Pour l'installer plutôt dans une **VM de la Freebox** (Delta ou Ultra, processeur ARM) :
> voir [docs/vm-freebox.md](docs/vm-freebox.md). L'image est publiée pour amd64 et arm64.

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
   | `PUBLIC_URL` | facultatif, adresse de ce serveur vue par la box pour ses notifications (ex. `http://192.168.1.20:8086`), modifiable dans l'interface |
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

Fréquences de collecte : `POLL_CONNECTION_SECONDS` (10), `POLL_DEVICES_SECONDS` (30), `POLL_SYSTEM_SECONDS` (60), `POLL_TRAFFIC_SECONDS` (30).

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

- Fonctions de l'appli Android reprises (lot 2) : fait, sauf l'inscription des téléphones via le relais Firebase
- À venir : ping et qualité Internet (latence, perte), surveillance des services (Home Assistant, NPM, Mealie, Proxmox)
- **Lot 3** : test de débit planifié, Wi-Fi par appareil, rapport mensuel, capteurs MQTT pour Home Assistant
