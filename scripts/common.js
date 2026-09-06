const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'out');

if (!fs.existsSync(path.join(OUT, 'ssap.js'))) {
  console.error('Not compiled yet. Run:  npm run compile');
  process.exit(1);
}

const { loadEnv, setEnvValue } = require(path.join(OUT, 'env'));

const env = loadEnv(ROOT);

const num = (key, fallback) => {
  const v = Number(env[key]);
  return Number.isFinite(v) ? v : fallback;
};

const config = {
  tvIp: env.WEBOS_TV_IP || '',
  clientKey: env.WEBOS_CLIENT_KEY || '',
  lanIp: env.LOCAL_LAN_IP || '',
  port: num('WEBOS_PORT', 7337),
  framerate: num('WEBOS_FRAMERATE', 15),
  width: num('WEBOS_WIDTH', 1280),
  quality: num('WEBOS_QUALITY', 6),
  monitor: num('WEBOS_MONITOR', 0),
  ffmpegPath: env.FFMPEG_PATH || 'ffmpeg'
};

const c = {
  ok: (s) => `[32m${s}[0m`,
  bad: (s) => `[31m${s}[0m`,
  warn: (s) => `[33m${s}[0m`,
  dim: (s) => `[90m${s}[0m`,
  bold: (s) => `[1m${s}[0m`
};

const PASS = c.ok('PASS');
const FAIL = c.bad('FAIL');
const WARN = c.warn('WARN');

/** Resolves the TV address from .env, falling back to SSDP discovery. */
async function resolveTv() {
  if (config.tvIp) {
    return { address: config.tvIp, name: config.tvIp, discovered: false };
  }
  const { discover } = require(path.join(OUT, 'discovery'));
  process.stdout.write('Discovering webOS TVs (3s)... ');
  const found = await discover(3000);
  if (found.length === 0) {
    console.log(c.bad('none found'));
    throw new Error(
      'No TV found. Check the TV is on and on the same network, then set WEBOS_TV_IP in .env\n' +
        '(the TV shows its address under Settings > General > Network).'
    );
  }
  console.log(c.ok(`found ${found[0].name}`));
  return { ...found[0], discovered: true };
}

module.exports = { ROOT, OUT, env, config, setEnvValue, c, PASS, FAIL, WARN, resolveTv };
