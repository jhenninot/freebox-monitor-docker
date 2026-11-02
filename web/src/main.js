import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './style.css';
import AccountView from './views/AccountView.vue';
import DeviceView from './views/DeviceView.vue';
import DevicesView from './views/DevicesView.vue';
import EventsView from './views/EventsView.vue';
import HomeView from './views/HomeView.vue';
import LoginView from './views/LoginView.vue';
import PairingView from './views/PairingView.vue';
import BoxNotifView from './views/network/BoxNotifView.vue';
import DhcpView from './views/network/DhcpView.vue';
import PortForwardView from './views/network/PortForwardView.vue';
import VpnClientView from './views/network/VpnClientView.vue';
import VpnView from './views/network/VpnView.vue';
import WifiFilterView from './views/network/WifiFilterView.vue';
import NetworkView from './views/network/NetworkView.vue';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: HomeView, meta: { title: 'Accueil' } },
    { path: '/appareils', component: DevicesView, meta: { title: 'Appareils' } },
    { path: '/appareils/:key', component: DeviceView, props: (r) => ({ deviceKey: r.params.key }), meta: { title: 'Appareil' } },
    { path: '/reseau', component: NetworkView, meta: { title: 'Réseau' } },
    { path: '/reseau/ip-fixes', component: DhcpView, meta: { title: 'IP fixes' } },
    { path: '/reseau/redirections', component: PortForwardView, meta: { title: 'Redirections de ports' } },
    { path: '/reseau/vpn', component: VpnView, meta: { title: 'Serveur VPN' } },
    { path: '/reseau/client-vpn', component: VpnClientView, meta: { title: 'Client VPN' } },
    { path: '/reseau/notifications', component: BoxNotifView, meta: { title: 'Notifications de la box' } },
    { path: '/reseau/filtrage-wifi', component: WifiFilterView, meta: { title: 'Filtrage Wi-Fi' } },
    { path: '/journal', component: EventsView, meta: { title: 'Journal et alertes' } },
    { path: '/association', component: PairingView, meta: { title: 'Association' } },
    { path: '/compte', component: AccountView, meta: { title: 'Mon compte' } },
    { path: '/connexion', component: LoginView, meta: { title: 'Connexion', public: true } },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

router.afterEach((to) => {
  document.title = `${to.meta.title} · Freebox Monitor`;
});

createApp(App).use(router).mount('#app');

// Service worker : appli installable et notifications push (HTTPS ou localhost uniquement)
if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('Service worker non enregistré', e));
}
