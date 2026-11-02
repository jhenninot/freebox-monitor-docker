# Installer Freebox Monitor dans une VM de la Freebox

La Freebox **Delta** et la Freebox **Ultra** peuvent héberger des machines virtuelles (pas la Pop ni la Révolution).
Ces VM tournent sur le processeur ARM de la box : l'image `ghcr.io/jhenninot/freebox-monitor-docker`
est publiée pour `linux/amd64` **et** `linux/arm64`, Docker choisit tout seul la bonne.

L'appli est légère (un processus Node, une base SQLite) : une VM Debian avec 1 vCPU, 512 Mo à 1 Go de RAM
et un disque de 8 Go suffit largement.

## 1. Créer la VM dans Freebox OS

1. Ouvrir Freebox OS (`http://mafreebox.freebox.fr`), application **VMs** (ou *Machines virtuelles*), puis **Ajouter une VM**.
2. Choisir l'image **Debian** (la plus récente proposée).
3. Ressources : 1 vCPU, 1 Go de RAM, disque de 8 Go ou plus, stocké sur le disque interne
   (ou sur un disque/SSD branché à la box).
4. Configuration du premier démarrage (cloud-init) :
   - un **nom d'hôte**, par exemple `freebox-monitor` ;
   - un **utilisateur** et, de préférence, ta **clé SSH publique** (sinon un mot de passe).
5. Créer, puis **Démarrer** la VM. Si Freebox OS propose une option de démarrage automatique, l'activer
   pour que la VM reparte après un redémarrage de la box.

## 2. Lui donner une adresse fixe

La VM est sur le réseau local comme n'importe quel appareil et reçoit son IP du DHCP de la box.

1. Freebox OS > **Périphériques réseau** : repérer la VM (nom d'hôte choisi plus haut).
2. *Paramètres de la Freebox > DHCP > Baux statiques* : ajouter un bail pour l'adresse MAC de la VM,
   par exemple `192.168.1.50`.
3. Redémarrer la VM pour qu'elle prenne cette adresse.

## 3. Se connecter et installer Docker

```bash
ssh <utilisateur>@192.168.1.50

sudo apt update && sudo apt full-upgrade -y
# Docker officiel (paquets arm64 fournis par Docker)
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
# se déconnecter puis se reconnecter pour que le groupe docker soit pris en compte
docker run --rm hello-world
```

`docker compose` est installé avec (plugin `docker-compose-plugin`).

## 4. Déployer Freebox Monitor

```bash
mkdir -p ~/freebox-monitor && cd ~/freebox-monitor
curl -fsSLO https://raw.githubusercontent.com/jhenninot/freebox-monitor-docker/main/docker-compose.yml
```

> Si le dépôt est privé, copier le fichier depuis ton poste :
> `scp docker-compose.yml <utilisateur>@192.168.1.50:~/freebox-monitor/`

Créer le fichier `.env` à côté (il remplace les variables de stack de Dockhand) :

```bash
cat > .env <<EOF
APP_SECRET=$(openssl rand -hex 32)
ADMIN_USERNAME=admin
ADMIN_PASSWORD='Choisis-un-mot-de-passe-2026!'
FREEBOX_URL=http://mafreebox.freebox.fr
EOF
chmod 600 .env
```

Garder une copie de `APP_SECRET` : s'il change, il faut refaire l'association.

Si le paquet ghcr.io est **privé**, se connecter une fois au registre (jeton GitHub avec le droit `read:packages`) :

```bash
echo <jeton> | docker login ghcr.io -u jhenninot --password-stdin
```

Puis lancer :

```bash
docker compose up -d
docker compose logs -f     # attendre « Freebox Monitor … prêt sur le port 8080 », puis Ctrl+C
```

## 5. Associer l'appli à la Freebox

1. Ouvrir `http://192.168.1.50:8086` et se connecter avec `admin` et `ADMIN_PASSWORD` (12 caractères minimum, minuscule,
   majuscule, chiffre et caractère spécial, sinon il faudra le changer à la connexion). Ensuite le mot de passe est gardé
   haché dans la base et se change dans **Mon compte** : `ADMIN_PASSWORD` peut être retiré du `.env`.
2. Cliquer sur **Associer** et valider avec la flèche droite sur l'écran du Freebox Server.
3. Pour pouvoir renommer des appareils : Freebox OS > *Paramètres de la Freebox > Gestion des accès > Applications*,
   éditer « Freebox Monitor (serveur) » et cocher **Modification des réglages de la Freebox**.

Si l'association échoue parce que `mafreebox.freebox.fr` ne répond pas, mettre `FREEBOX_URL=http://192.168.1.254`
dans `.env` puis `docker compose up -d`.

## 6. Mettre à jour

```bash
cd ~/freebox-monitor
docker compose pull && docker compose up -d
docker image prune -f
```

Pour le faire automatiquement chaque nuit : `crontab -e` puis
`30 4 * * * cd ~/freebox-monitor && docker compose pull -q && docker compose up -d && docker image prune -f`.

## Bon à savoir

- **La VM s'arrête avec la box.** Pendant un redémarrage de la Freebox, rien n'est mesuré : l'appli verra
  le redémarrage au retour (durée depuis le démarrage) mais ne pourra pas alerter *pendant* la coupure.
  Pendant une coupure Internet, les notifications push sont gardées et envoyées au retour de la connexion.
  Le serveur Docker sous Proxmox reste un meilleur poste d'observation pour les coupures de courant de la box.
- **Une seule instance à la fois.** Si l'appli tourne déjà dans Dockhand, l'arrêter (ou ne pas l'associer deux fois)
  pour éviter des alertes en double. Pour garder l'historique, copier la base : `docker compose stop`, puis récupérer
  `/data/freebox-monitor.db` du volume de l'ancienne instance et le déposer dans le volume de la nouvelle, en reprenant **le même `APP_SECRET`** (sinon refaire l'association).
- **Accès depuis l'extérieur** : comme pour le serveur Docker, rester en local et passer par le VPN de la Freebox.
  Pour NPM, faire pointer le Proxy Host vers `http://192.168.1.50:8086` : c'est nécessaire pour les notifications push,
  qui exigent le HTTPS (voir [https-npm.md](https-npm.md)).
- **Dockhand** peut aussi gérer ce Docker comme un environnement distant, si tu préfères tout piloter au même endroit.
