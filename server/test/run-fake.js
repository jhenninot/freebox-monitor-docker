// Lance une fausse Freebox sur le port 8090 pour essayer l'interface sans box (node test/run-fake.js)
import { host, startFakeFreebox } from './fake-freebox.js';

const box = await startFakeFreebox(8090);
const t = Math.floor(Date.now() / 1000);
box.state.hosts = [
  { ...host('ether-1', 'AA:00:00:00:00:01', 'proxmox', { ip: '192.168.1.20' }), local_domain: 'home.arpa', domain_name: 'pve.home.arpa', names: [{ name: 'pve', source: 'dhcp' }], info: { upnp: { modelName: 'Proxmox VE', manufacturer: 'Proxmox' } } },
  host('ether-2', 'AA:00:00:00:00:02', 'homeassistant', { ip: '192.168.1.30' }),
  host('ether-3', 'AA:00:00:00:00:03', 'iPhone de Julien', { ip: '192.168.1.51' }),
  host('ether-4', 'AA:00:00:00:00:04', 'Imprimante', { ip: '192.168.1.60', reachable: false, lastSeen: t - 7200 }),
  // Pour essayer le scan de ports : cette machine (l'interface sur 8080, la fausse box sur 8090)
  host('ether-5', 'AA:00:00:00:00:05', 'Cette machine', { ip: '127.0.0.1' }),
];
// Appareils en câble (les autres sont en Wi-Fi)
for (const h of box.state.hosts.filter((x) => ['proxmox', 'homeassistant', 'Imprimante'].includes(x.primary_name))) {
  h.access_point = { connectivity_type: 'ethernet' };
}
// Types variés pour essayer les icônes
const TYPES = { proxmox: 'nas', homeassistant: 'networking_device', 'iPhone de Julien': 'smartphone', Imprimante: 'printer', 'Cette machine': 'laptop' };
for (const h of box.state.hosts) h.host_type = TYPES[h.primary_name] ?? 'workstation';
box.state.staticLeases = [{ id: 'AA:00:00:00:00:02', mac: 'AA:00:00:00:00:02', ip: '192.168.1.30', comment: 'Home Assistant', hostname: 'homeassistant' }];
box.state.dynamicLeases = [
  { mac: 'AA:00:00:00:00:01', ip: '192.168.1.20', hostname: 'proxmox', is_static: false, lease_remaining: 40000 },
  { mac: 'AA:00:00:00:00:03', ip: '192.168.1.51', hostname: 'iPhone', is_static: false, lease_remaining: 3000 },
];
box.state.system.sensors.push({ id: 'temp_hdd', name: 'Disque', value: 87 });
box.state.switchStatus = [{ id: 1, link: 'up', mac_list: [{ mac: 'AA:00:00:00:00:01' }] }, { id: 2, link: 'up', mac_list: [{ mac: 'AA:00:00:00:00:02' }, { mac: 'AA:00:00:00:00:09', hostname: 'tv' }] }];
box.state.portStats = { 1: { tx_bytes: 9e10, rx_good_bytes: 2e10 }, 2: { tx_bytes: 3e9, rx_good_bytes: 1e9 } };
box.state.stations[1] = [{ mac: 'AA:00:00:00:00:03', hostname: 'iPhone', tx_bytes: 4e8, rx_bytes: 5e7 }];
box.state.redirs = [
  { id: 100, enabled: true, ip_proto: 'tcp', wan_port_start: 443, wan_port_end: 443, lan_ip: '192.168.1.20', lan_port: 443, src_ip: '0.0.0.0', comment: 'Nginx Proxy Manager', hostname: 'proxmox' },
  { id: 101, enabled: false, ip_proto: 'udp', wan_port_start: 51820, wan_port_end: 51820, lan_ip: '192.168.1.30', lan_port: 51820, src_ip: '0.0.0.0', comment: 'WireGuard', hostname: '' },
];
// Répéteurs Wi-Fi (l'un déconnecté) et le système complet
Object.assign(box.state.system, { serial: '123456789012345', mac: '14:0C:76:00:00:01', disk_status: 'active' });
box.state.repeaters = [
  { id: 1, name: 'Répéteur salon', model: 'fbxwmr', firmware_version: '1.4.2', status: 'running', connection: 'connected', boot_time: t - 5 * 86400, last_seen: t, led_activated: true, main_mac: '14:0C:76:00:00:10', sn: 'RPT0001', api_ver: '1.0' },
  { id: 2, name: 'Répéteur étage', model: 'fbxwmr', firmware_version: '1.4.2', status: 'running', connection: 'disconnected', boot_time: t - 9 * 86400, last_seen: t - 1800, led_activated: false, main_mac: '14:0C:76:00:00:11', sn: 'RPT0002', api_ver: '1.0' },
];
box.state.repeaterHosts[1] = [{ l2ident: { id: 'AA:00:00:00:00:03', type: 'mac_address' }, active: true, access_point: { connectivity_type: 'wifi', wifi_information: { band: '5g' } } }];
box.state.macFilters = [{ id: 'AA:00:00:00:00:04-blacklist', mac: 'AA:00:00:00:00:04', type: 'blacklist', comment: 'Imprimante', hostname: '' }];
// Validation automatique de l'association au bout de 4 s, débits qui bougent
setTimeout(() => { box.state.authStatus = 'granted'; }, 4000);
setInterval(() => {
  box.state.connection.rate_down = Math.round(2e6 + Math.random() * 6e7);
  box.state.connection.rate_up = Math.round(1e5 + Math.random() * 5e6);
  box.state.portStats[1].tx_bytes_rate = Math.round(Math.random() * 4e6);
  box.state.portStats[1].rx_bytes_rate = Math.round(Math.random() * 2e5);
  box.state.portStats[2].tx_bytes_rate = Math.round(Math.random() * 1e5);
  box.state.stations[1][0].tx_rate = Math.round(Math.random() * 1e6);
  box.state.stations[1][0].rx_rate = Math.round(Math.random() * 1e5);
}, 1000);
console.log(`Fausse Freebox sur ${box.url}`);
