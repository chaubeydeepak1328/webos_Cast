/**
 * Full cast from the terminal -- the same pipeline the extension runs, without
 * needing the Extension Development Host. Ctrl+C stops cleanly.
 */
const path = require('path');
const { ROOT, OUT, config, setEnvValue, c, resolveTv } = require('./common');
const { SsapClient } = require(path.join(OUT, 'ssap'));
const { ScreenCapture } = require(path.join(OUT, 'capture'));
const { StreamServer } = require(path.join(OUT, 'server'));
const { bestLanAddress } = require(path.join(OUT, 'net'));

let capture;
let server;
let ssap;
let closing = false;

async function shutdown(code = 0) {
  if (closing) {
    return;
  }
  closing = true;
  console.log('\nStopping...');
  try {
    capture && capture.stop();
    server && (await server.close());
    if (ssap && ssap.connected) {
      await ssap.closeBrowser().catch(() => undefined);
      ssap.close();
    }
  } catch {
    /* best effort */
  }
  console.log('Stopped.\n');
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

(async () => {
  console.log(c.bold('\nwebOS Cast\n'));

  const tv = await resolveTv();
  console.log(`TV:      ${c.bold(tv.name)} @ ${tv.address}`);

  // 1. Control channel.
  ssap = new SsapClient({ address: tv.address, pairTimeoutMs: 120000 });
  ssap.on('log', (m) => console.log(c.dim(`  ${m}`)));
  ssap.on('prompt', () =>
    console.log(c.warn('\n  >> Accept the prompt on the TV to continue...\n'))
  );
  ssap.on('disconnected', () =>
    console.log(c.warn('  control link dropped (the picture keeps streaming)'))
  );
  await ssap.connect();

  let key;
  try {
    key = await ssap.register(config.clientKey || undefined);
  } catch (err) {
    console.error(c.bad('\nRegistration failed: ') + err.message);
    console.error('Run ' + c.bold('npm run pair') + ' first.\n');
    process.exit(1);
  }
  if (key !== config.clientKey) {
    setEnvValue(ROOT, 'WEBOS_CLIENT_KEY', key);
    console.log(c.dim('  client key refreshed in .env'));
  }

  // 2. Capture.
  capture = new ScreenCapture({
    ffmpegPath: config.ffmpegPath,
    method: 'auto',
    framerate: config.framerate,
    width: config.width,
    quality: config.quality,
    monitor: config.monitor
  });
  capture.on('started', (m) => console.log(`Capture: ${m}, ${config.width}px @ ${config.framerate} fps`));
  capture.on('error', (err) => {
    console.error(c.bad('Capture stopped: ') + err.message);
    shutdown(1);
  });
  await capture.start();

  // 3. Serve.
  server = new StreamServer(capture);
  // Leading newline so log lines are not clobbered by the \r status line.
  server.on('log', (m) => console.log(`\n${c.dim('  ' + m)}`));
  let port = config.port;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      port = await server.listen(config.port + attempt);
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE' || attempt === 9) {
        throw err;
      }
    }
  }

  const host = config.lanIp || bestLanAddress(tv.address);
  if (!host) {
    throw new Error('No LAN address found. Set LOCAL_LAN_IP in .env');
  }
  const url = `http://${host}:${port}/?t=${server.token}`;
  console.log(`Stream:  ${url}`);

  // 4. Point the TV at it.
  await ssap.openUrl(url);
  ssap.toast('Screen cast started from VS Code').catch(() => undefined);
  console.log(c.ok('\nCasting. ') + 'The TV browser should be showing this screen.');
  console.log(c.dim('Press Ctrl+C to stop.\n'));

  let lastCount = 0;
  let announced = false;
  setInterval(() => {
    const total = capture.frameCount;
    const fps = (total - lastCount) / 5;
    lastCount = total;
    const viewers = server.viewerCount;
    if (viewers > 0 && !announced) {
      announced = true;
      console.log(c.ok('TV connected to the stream.'));
    }
    process.stdout.write(
      `\r${c.dim(`  viewers ${viewers}  |  ${fps.toFixed(1)} fps captured  |  ${total} frames total   `)}`
    );
  }, 5000).unref?.();
})().catch(async (err) => {
  console.error(c.bad('\nFailed: ') + err.message + '\n');
  await shutdown(1);
});
