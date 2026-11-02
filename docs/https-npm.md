# Passer Freebox Monitor en HTTPS avec Nginx Proxy Manager

Les navigateurs n'autorisent les **notifications push** et l'**installation de l'appli** (PWA) que sur une adresse
en HTTPS. `http://192.168.0.94:8086` ne suffit pas : il faut passer par Nginx Proxy Manager (NPM), qui ajoute un
certificat Let's Encrypt devant l'appli.

```
Téléphone / PC ──https──> NPM (LXC Proxmox) ──http──> VM Freebox 192.168.0.94:8086
                                                         │
Google / Mozilla / Apple <── notifications push ─────────┘ (sortant uniquement)
```

Les notifications partent du serveur vers les services de push de Google (Chrome, Android), Mozilla (Firefox) ou
Apple (iPhone), qui les livrent au téléphone **où qu'il soit**, même hors de la maison. Rien n'a besoin d'entrer chez
toi pour les recevoir : seul l'affichage de l'appli (clic sur la notification) demande d'être sur le réseau local ou le VPN.

## 1. Un nom de domaine

Il faut un nom qui pointe vers NPM, par exemple `freebox.mondomaine.fr`, dans le même domaine que tes autres
services (Home Assistant, Mealie…). Deux cas :

- **NPM est déjà joignable depuis Internet** (redirections des ports 80 et 443 de la Freebox vers le LXC NPM) :
  ajoute chez ton fournisseur DNS un enregistrement `freebox` (CNAME vers ton domaine principal, ou A vers ton IP
  publique). Le certificat sera obtenu par le défi HTTP, le plus simple.
- **Rien n'est ouvert vers l'extérieur** : crée l'enregistrement `freebox` de type A vers l'**IP locale du LXC NPM**
  (192.168.0.x) et obtiens le certificat par le **défi DNS** (étape 3, « Use a DNS Challenge », avec le jeton API de ton
  fournisseur DNS : Cloudflare, OVH, Gandi…). L'appli n'est alors jamais joignable depuis Internet.

## 2. Une Access List (recommandé)

L'appli peut modifier la box : ne la laisse pas ouverte à tout Internet. Dans NPM, *Access Lists > Add Access List* :

- *Details* : nom `LAN + VPN`, **Satisfy Any** coché
- *Access* : `allow 192.168.0.0/24` (ton réseau local), `allow` la plage des clients du VPN de la Freebox
  (affichée dans *Réseau > Serveur VPN* de l'appli ou dans Freebox OS, par exemple `192.168.27.64/27`), puis `deny all`

Pas besoin d'*Authorization* : l'appli a déjà son mot de passe.

## 3. Le Proxy Host

*Hosts > Proxy Hosts > Add Proxy Host* :

**Details**
| Champ | Valeur |
| --- | --- |
| Domain Names | `freebox.mondomaine.fr` |
| Scheme | `http` |
| Forward Hostname / IP | `192.168.0.94` |
| Forward Port | `8086` |
| Cache Assets | non |
| Block Common Exploits | oui |
| Websockets Support | facultatif (l'appli utilise des Server-Sent Events, qui passent sans) |
| Access List | `LAN + VPN` |

**SSL**
- *SSL Certificate* : **Request a new SSL Certificate** (ou « Use a DNS Challenge » dans le second cas de l'étape 1)
- **Force SSL** et **HTTP/2 Support** cochés ; HSTS facultatif
- accepter les conditions Let's Encrypt, *Save*

Aucun réglage *Advanced* n'est nécessaire : le flux temps réel désactive lui-même la mise en tampon de Nginx, et l'appli
fait confiance aux en-têtes `X-Forwarded-*` de NPM (réseau local), donc le cookie de session passe en `Secure`.

## 4. Vérifier

Ouvre `https://freebox.mondomaine.fr` : cadenas dans la barre d'adresse, puis connexion avec ton mot de passe habituel.

## 5. Activer les notifications sur chaque appareil

Toujours depuis l'adresse **https** (un abonnement est lié à l'adresse : celui pris sur une autre adresse ne compte pas).

- **Chrome sur ordinateur** : *Journal et alertes > Notifications push > Activer sur cet appareil*, puis **Autoriser**.
  Pour l'installer en appli : icône « Installer » à droite de la barre d'adresse (ou menu ⋮ > *Caster, enregistrer et
  partager > Installer la page en tant qu'appli*).
- **Android (Chrome)** : menu ⋮ > **Installer l'appli** (ou *Ajouter à l'écran d'accueil*), ouvre l'appli depuis son
  icône, puis *Journal et alertes > Activer sur cet appareil*. Si les notifications arrivent en retard, retire
  l'optimisation de batterie de Chrome.
- **iPhone (iOS 16.4 ou plus)** : dans **Safari**, bouton Partager > **Sur l'écran d'accueil**, ouvre l'appli depuis
  l'icône (obligatoire sur iPhone), puis *Activer sur cet appareil*.

Le bouton **Tester la notification** envoie une notification à tous les appareils abonnés ; la liste montre chaque
appareil et la dernière notification reçue. *Retirer* désabonne un appareil perdu ou remplacé.

## Bon à savoir

- **Quelles alertes ?** Toutes celles du journal : nouvel appareil, appareil surveillé hors ligne et de retour,
  coupure et retour d'Internet, changement d'IP publique, redémarrage et surchauffe de la box, port ouvert au scan
  de nuit, notifications de la Freebox elle-même. Les plus importantes restent affichées jusqu'à ce que tu les touches.
- **Coupure Internet** : la notification « Connexion Internet perdue » ne peut pas partir pendant la coupure ;
  elle est gardée et envoyée dès le retour du réseau (jusqu'à 24 h).
- **Notifications de la box** : l'adresse vue par la Freebox (`PUBLIC_URL`, réglable dans *Réseau > Notifications de la
  box*) reste `http://192.168.0.94:8086` : la box appelle l'appli en direct, sans passer par NPM.
- **Changer `APP_SECRET`** recrée les clés des notifications : il faut alors réactiver chaque appareil.
- **Mises à jour** : rien à faire, Watchtower récupère la nouvelle image ; l'appli installée se met à jour seule.
