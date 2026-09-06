/**
 * Preflight checks. Everything here runs without touching the TV screen --
 * no pairing prompt is raised, so it is safe to run any time.
 */
const path = require('path');
const http = require('http');

const { execFile } = require('child_process');
const { ROOT, OUT, config, c, PASS, FAIL, WARN } = require('./common');

const { ScreenCapture } = require(path.join(OUT, 'capture'));
const { StreamServer } = require(path.join(OUT, 'server'));
const { discover } = require(path.join(OUT, 'discovery'));
const { bestLanAddress, lanInterfaces } = require(path.join(OUT, 'net'));

let failures = 0;
const line = (status, label, detail) =>
  console.log(`  ${status}  ${label}${detail ? '\n        ' + c.dim(detail) : ''}`);
const fail = (label, detail) => {
  failures++;
  line(FAIL, label, detail);
};

/**
 * Attempts a real WebSocket handshake. A raw TCP probe is not enough: newer
 * webOS accepts the connection on :3000 but refuses the upgrade, so a port
 * that looks "open" is still unusable. Opening the socket raises no prompt --
 * only registration does that.
 */
function wsProbe(url, timeout = 5000) {
  const WebSocket = require('ws');
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try {
        ws.terminate();
      } catch {
        /* already gone */
      }
      resolve(result);
    };
    const ws = new WebSocket(url, { rejectUnauthorized: false, handshakeTimeout: timeout });
    ws.once('open', () => done({ ok: true }));
    ws.once('error', (err) => done({ ok: false, reason: err.message }));
    setTimeout(() => done({ ok: false, reason: 'timeout' }), timeout + 500);
  });
}

(async () => {
  console.log(c.bold('\nwebOS Cast -- preflight\n'));

  // 1. ffmpeg
  const version = await new Promise((resolve) => {
    execFile(config.ffmpegPath, ['-version'], (err, stdout) =>
      resolve(err ? null : String(stdout).split('\n')[0])
    );
  });
  if (version) {
    line(PASS, 'ffmpeg', version);
  } else {
    fail('ffmpeg', `Cannot run "${config.ffmpegPath}". Install it or set FFMPEG_PATH in .env`);
  }

  // 2. Network adapters
  const ifaces = lanInterfaces();
  if (ifaces.length === 0) {
    fail('LAN adapter', 'No non-internal IPv4 address on this machine.');
  } else {
    line(PASS, 'LAN adapter', ifaces.map((i) => `${i.name} = ${i.address}/${i.netmask}`).join('  |  '));
  }

  // 3. Find the TV
  let tv = null;
  if (config.tvIp) {
    tv = { address: config.tvIp, name: config.tvIp };
    line(PASS, 'TV address', `${config.tvIp} (from .env)`);
  } else {
    const found = await discover(3000);
    if (found.length === 0) {
      fail('TV discovery', 'No webOS TV answered SSDP. Set WEBOS_TV_IP in .env, or check the TV is on.');
    } else {
      tv = found[0];
      line(PASS, 'TV discovery', found.map((t) => `${t.name} @ ${t.address}`).join(', '));
    }
  }

  // 4. Which control port the TV accepts
  if (tv) {
    const bind = config.lanIp || bestLanAddress(tv.address);
    if (bind) {
      line(PASS, 'Address advertised to TV', bind);
    } else {
      fail('Address advertised to TV', 'Could not pick one. Set LOCAL_LAN_IP in .env');
    }

    const [plain, secure] = await Promise.all([
      wsProbe(`ws://${tv.address}:3000`),
      wsProbe(`wss://${tv.address}:3001`)
    ]);
    const describe = (label, r) => `${label} ${r.ok ? 'usable' : `unusable (${r.reason})`}`;
    if (plain.ok || secure.ok) {
      line(
        PASS,
        'TV control channel',
        `${describe('ws:3000', plain)}  |  ${describe('wss:3001', secure)}` +
          (secure.ok && !plain.ok ? '\n        the secure port is the norm on 2023+ webOS' : '')
      );
    } else {
      fail(
        'TV control channel',
        `${describe('ws:3000', plain)}  |  ${describe('wss:3001', secure)}\n` +
          '        The TV may be asleep, on another network/VLAN, or have network control disabled.'
      );
    }
  }

  // 5. Pairing key
  if (config.clientKey) {
    line(PASS, 'Pairing key', `stored in .env (${config.clientKey.slice(0, 8)}...)`);
  } else {
    line(WARN, 'Pairing key', 'not set yet -- run:  npm run pair');
  }

  // 6. Capture + serve, end to end, locally
  if (version) {
    const capture = new ScreenCapture({
      ffmpegPath: config.ffmpegPath,
      method: 'auto',
      framerate: config.framerate,
      width: config.width,
      quality: config.quality,
      monitor: config.monitor
    });
    let backend = '?';
    capture.on('started', (m) => (backend = m));
    try {
      const t0 = Date.now();
      await capture.start();
      line(PASS, 'Screen capture', `${backend}, first frame in ${Date.now() - t0} ms`);

      const server = new StreamServer(capture);
      let port;
      try {
        port = await server.listen(config.port, '127.0.0.1');
      } catch (err) {
        port = await server.listen(0, '127.0.0.1');
        line(WARN, 'Stream port', `${config.port} unavailable (${err.code}); using ${port}`);
      }

      const stats = await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${port}/stream?t=${server.token}`, (res) => {
          let bytes = 0;
          let frames = 0;
          let buf = Buffer.alloc(0);
          const start = Date.now();
          res.on('data', (chunk) => {
            bytes += chunk.length;
            buf = Buffer.concat([buf, chunk]);
            for (;;) {
              const s = buf.indexOf(Buffer.from([0xff, 0xd8]));
              if (s < 0) break;
              const e = buf.indexOf(Buffer.from([0xff, 0xd9]), s + 2);
              if (e < 0) break;
              buf = buf.subarray(e + 2);
              frames++;
            }
            if (Date.now() - start > 3000) {
              req.destroy();
              const secs = (Date.now() - start) / 1000;
              resolve({ fps: frames / secs, mbps: bytes / secs / 125000 });
            }
          });
        });
        req.on('error', () => resolve(null));
      });

      if (stats && stats.fps > 0) {
        line(PASS, 'Stream', `${stats.fps.toFixed(1)} fps, ${stats.mbps.toFixed(1)} Mbit/s at ${config.width}px wide`);
      } else {
        fail('Stream', 'Server produced no frames.');
      }
      capture.stop();
      await server.close();
    } catch (err) {
      capture.stop();
      fail('Screen capture', err.message);
    }
  }

  console.log(
    failures === 0
      ? c.ok('\nAll checks passed.') + (config.clientKey ? '  Run:  npm run cast\n' : '  Next:  npm run pair\n')
      : c.bad(`\n${failures} check(s) failed.`) + ' Fix the above, then re-run:  npm run doctor\n'
  );
  process.exit(failures === 0 ? 0 : 1);
})().catch((err) => {
  console.error(c.bad('\nDoctor crashed: ') + err.message + '\n');
  process.exit(1);
});
