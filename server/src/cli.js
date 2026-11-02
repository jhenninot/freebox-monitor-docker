// Commandes d'administration, à lancer dans le conteneur :
//   docker exec -it freebox-monitor node src/cli.js comptes
//   docker exec -it freebox-monitor node src/cli.js reinitialiser <identifiant>
import { Accounts, randomPassword } from './auth.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

const [command, username] = process.argv.slice(2);
const store = openDatabase(loadConfig().dbFile);
const accounts = new Accounts(store);
let code = 0;

if (command === 'comptes') {
  const rows = store.db.prepare('SELECT username, locked_until FROM users ORDER BY id').all();
  if (!rows.length) console.log('Aucun compte');
  for (const r of rows) console.log(`${r.username}${r.locked_until > Date.now() / 1000 ? ' (bloqué après des essais ratés)' : ''}`);
} else if (command === 'reinitialiser' && username) {
  const user = accounts.find(username);
  if (!user) {
    console.error(`Compte « ${username} » inconnu (liste : node src/cli.js comptes)`);
    code = 1;
  } else {
    const password = randomPassword();
    await accounts.setPassword(user.id, password, { mustChange: true });
    console.log(`Mot de passe provisoire de « ${user.username} » : ${password}`);
    console.log('Il faudra le changer à la prochaine connexion. Les sessions ouvertes sont fermées.');
  }
} else {
  console.log('Usage : node src/cli.js comptes | reinitialiser <identifiant>');
  code = 1;
}
store.close();
process.exit(code);
