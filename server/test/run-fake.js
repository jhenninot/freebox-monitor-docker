// Lance une fausse Freebox sur le port 8090 pour essayer l'interface sans box (node test/run-fake.js)
import { host, startFakeFreebox } from './fake-freebox.js';

const box = await startFakeFreebox(8090);
const t = Math.floor(Date.now() / 1000);
box.state.hosts = [
  host('ether-1', 'AA:00:00:00:00:01', 'proxmox', { ip: '192.168.1.20' }),
  host('ether-2', 'AA:00:00:00:00:02', 'homeassistant', { ip: '192.168.1.30' }),
  host('ether-3', 'AA:00:00:00:00:03', 'iPhone de Julien', { ip: '192.168.1.51' }),
  host('ether-4', 'AA:00:00:00:00:04', 'Imprimante', { ip: '192.168.1.60', reachable: false, lastSeen: t - 7200 }),
];
// Validation automatique de l'association au bout de 4 s, débits qui bougent
setTimeout(() => { box.state.authStatus = 'granted'; }, 4000);
setInterval(() => {
  box.state.connection.rate_down = Math.round(2e6 + Math.random() * 6e7);
  box.state.connection.rate_up = Math.round(1e5 + Math.random() * 5e6);
}, 1000);
console.log(`Fausse Freebox sur ${box.url}`);
