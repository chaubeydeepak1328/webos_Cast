/**
 * One-time pairing. Raises the accept prompt on the TV, then writes the
 * returned client key into .env so nothing has to be copied by hand.
 */
const path = require('path');
const { ROOT, OUT, config, setEnvValue, c, resolveTv } = require('./common');
const { SsapClient } = require(path.join(OUT, 'ssap'));

(async () => {
  console.log(c.bold('\nwebOS Cast -- pairing\n'));

  const tv = await resolveTv();
  console.log(`TV: ${c.bold(tv.name)} @ ${tv.address}\n`);

  const client = new SsapClient({ address: tv.address, pairTimeoutMs: 120000 });
  client.on('log', (m) => console.log(c.dim(`  ${m}`)));
  client.on('prompt', () => {
    console.log('');
    console.log(c.warn('  >> Look at the TV now.'));
    console.log(c.warn('  >> A prompt is asking whether to allow "VS Code Screen Cast".'));
    console.log(c.warn('  >> Select Yes / Accept with the remote. Waiting up to 2 minutes...'));
    console.log('');
  });

  process.stdout.write('Connecting... ');
  await client.connect();

  let key;
  try {
    // Any stored key is reused; passing it avoids a needless prompt when the
    // TV already trusts us.
    key = await client.register(config.clientKey || undefined);
  } catch (err) {
    client.close();
    console.error(c.bad('\nPairing failed: ') + err.message + '\n');
    console.error('Things to check:');
    console.error('  - The prompt was accepted on the TV within the timeout.');
    console.error('  - Settings > General > External Devices, or Network, allows app connections.');
    console.error('  - If the TV refuses registration outright, see the note about the');
    console.error('    manifest `signatures` block in src/ssap.ts.\n');
    process.exit(1);
  }

  setEnvValue(ROOT, 'WEBOS_CLIENT_KEY', key);
  if (tv.discovered) {
    setEnvValue(ROOT, 'WEBOS_TV_IP', tv.address);
  }

  console.log(c.ok('\nPaired.') + ` Client key saved to .env (${key.slice(0, 8)}...).`);

  // Prove the key actually works for a real command, not just registration.
  try {
    await client.toast('VS Code paired successfully');
    console.log(c.ok('Verified.') + ' A toast should have appeared on the TV.');
  } catch (err) {
    console.log(c.warn('Note: ') + `pairing succeeded but the test toast failed (${err.message}).`);
  }

  client.close();
  console.log('\nNext:  ' + c.bold('npm run cast') + '\n');
  setTimeout(() => process.exit(0), 200);
})().catch((err) => {
  console.error(c.bad('\nFailed: ') + err.message + '\n');
  process.exit(1);
});
