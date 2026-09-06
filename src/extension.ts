import * as vscode from 'vscode';
import { discover, DiscoveredTv } from './discovery';
import { bestLanAddress } from './net';
import { CaptureMethod, ScreenCapture } from './capture';
import { SsapClient } from './ssap';
import { StreamServer } from './server';
import { KeepAwake } from './keepawake';
import { loadEnv } from './env';

const LAST_TV = 'webosCast.lastTv';
const keySecret = (address: string) => `webosCast.clientKey.${address}`;

let log: vscode.OutputChannel;
let status: vscode.StatusBarItem;
let session: Session | undefined;

interface Tv {
  address: string;
  name: string;
}

interface Session {
  tv: Tv;
  ssap: SsapClient;
  capture: ScreenCapture;
  server: StreamServer;
  keepAwake?: KeepAwake;
  url: string;
}

export function activate(context: vscode.ExtensionContext): void {
  log = vscode.window.createOutputChannel('webOS Cast');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.command = 'webosCast.stop';

  context.subscriptions.push(
    log,
    status,
    vscode.commands.registerCommand('webosCast.cast', () => cast(context, false)),
    vscode.commands.registerCommand('webosCast.pair', () => cast(context, true)),
    vscode.commands.registerCommand('webosCast.stop', () => stopCast('Stopped casting.')),
    vscode.commands.registerCommand('webosCast.forget', () => forget(context)),
    vscode.commands.registerCommand('webosCast.openLocalPreview', openLocalPreview),
    vscode.commands.registerCommand('webosCast.showLog', () => log.show(true)),
    { dispose: () => void teardown() }
  );

  void seedFromEnv(context);
}

/**
 * Adopts a key produced by `npm run pair` so the CLI and the extension share
 * one pairing. Secret storage stays the source of truth; .env only seeds it.
 */
async function seedFromEnv(context: vscode.ExtensionContext): Promise<void> {
  try {
    const env = loadEnv(context.extensionPath);
    const address = env.WEBOS_TV_IP?.trim();
    const clientKey = env.WEBOS_CLIENT_KEY?.trim();
    if (!address || !clientKey) {
      return;
    }
    if ((await context.secrets.get(keySecret(address))) === clientKey) {
      return;
    }
    await context.secrets.store(keySecret(address), clientKey);
    if (!context.globalState.get<Tv>(LAST_TV)) {
      await context.globalState.update(LAST_TV, { address, name: address });
    }
    trace(`adopted pairing key for ${address} from .env`);
  } catch (err) {
    trace(`could not read .env: ${(err as Error).message}`);
  }
}

export function deactivate(): Thenable<void> {
  return teardown();
}

function cfg() {
  return vscode.workspace.getConfiguration('webosCast');
}

function trace(message: string): void {
  log.appendLine(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
}

// --- commands ---------------------------------------------------------------

async function cast(context: vscode.ExtensionContext, forcePair: boolean): Promise<void> {
  if (session) {
    const again = await vscode.window.showInformationMessage(
      `Already casting to ${session.tv.name}.`,
      'Restart',
      'Stop'
    );
    if (again === 'Stop') {
      await stopCast('Stopped casting.');
      return;
    }
    if (again !== 'Restart') {
      return;
    }
    await teardown();
  }

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Cast to webOS TV', cancellable: false },
      (progress) => startCast(context, forcePair, progress)
    );
  } catch (err) {
    await teardown();
    const message = (err as Error).message ?? String(err);
    trace(`cast failed: ${message}`);
    const action = await vscode.window.showErrorMessage(`Casting failed: ${message}`, 'Show Log');
    if (action === 'Show Log') {
      log.show(true);
    }
  }
}

async function startCast(
  context: vscode.ExtensionContext,
  forcePair: boolean,
  progress: vscode.Progress<{ message?: string }>
): Promise<void> {
  progress.report({ message: 'Finding TV…' });
  const tv = await resolveTv(context);
  trace(`target: ${tv.name} (${tv.address})`);

  // 1. Control channel.
  progress.report({ message: `Connecting to ${tv.name}…` });
  const stored = forcePair ? undefined : await context.secrets.get(keySecret(tv.address));

  const ssap = await connectAndRegister(tv, stored, progress);
  try {
    await finishCast(context, tv, ssap.client, ssap.clientKey, progress);
  } catch (err) {
    ssap.client.close();
    throw err;
  }
}

/**
 * Connects and registers, re-prompting once if a stored key is rejected. A key
 * goes stale when the TV is factory reset or this app is dropped from its
 * device list, and the only fix is a fresh prompt.
 */
async function connectAndRegister(
  tv: Tv,
  storedKey: string | undefined,
  progress: vscode.Progress<{ message?: string }>
): Promise<{ client: SsapClient; clientKey: string }> {
  const attempt = async (key: string | undefined) => {
    const client = new SsapClient({ address: tv.address });
    client.on('log', trace);
    client.on('prompt', () => {
      progress.report({ message: 'Accept the pairing prompt on your TV…' });
      void vscode.window.showInformationMessage('Accept the connection prompt on your TV to continue.');
    });
    await client.connect();
    try {
      return { client, clientKey: await client.register(key) };
    } catch (err) {
      client.close();
      throw err;
    }
  };

  try {
    return await attempt(storedKey);
  } catch (err) {
    if (!storedKey) {
      throw err;
    }
    trace(`stored key rejected (${(err as Error).message}), re-pairing`);
    return attempt(undefined);
  }
}

async function finishCast(
  context: vscode.ExtensionContext,
  tv: Tv,
  ssap: SsapClient,
  clientKey: string,
  progress: vscode.Progress<{ message?: string }>
): Promise<void> {
  await context.secrets.store(keySecret(tv.address), clientKey);
  await context.globalState.update(LAST_TV, tv);
  ssap.on('disconnected', () => trace('control connection to the TV dropped (stream unaffected)'));

  // 2. Capture.
  progress.report({ message: 'Starting screen capture…' });
  const c = cfg();
  const capture = new ScreenCapture({
    ffmpegPath: c.get<string>('ffmpegPath', 'ffmpeg'),
    method: c.get<CaptureMethod>('captureMethod', 'auto'),
    framerate: Math.max(1, c.get<number>('framerate', 15)),
    width: Math.max(160, c.get<number>('width', 1280)),
    quality: Math.min(31, Math.max(2, c.get<number>('quality', 6))),
    monitor: Math.max(0, c.get<number>('monitor', 0))
  });
  capture.on('log', trace);
  capture.on('started', (method: string) => trace(`capturing with ${method}`));
  capture.on('error', (err: Error) => {
    void vscode.window.showErrorMessage(`Screen capture stopped: ${err.message}`);
    void stopCast();
  });
  try {
    await capture.start();
  } catch (err) {
    throw new Error(
      `${(err as Error).message}\n\nCheck that ffmpeg is installed and on PATH, or set webosCast.ffmpegPath.`
    );
  }

  // 3. Pixel channel.
  progress.report({ message: 'Serving stream…' });
  const server = new StreamServer(capture);
  server.on('log', trace);
  let port: number;
  let host: string | undefined;
  try {
    port = await listenWithFallback(server, c.get<number>('port', 7337));
    host = c.get<string>('bindAddress') || bestLanAddress(tv.address);
    if (!host) {
      throw new Error('No LAN address found on this machine. Set webosCast.bindAddress manually.');
    }
  } catch (err) {
    capture.stop();
    await server.close();
    throw err;
  }

  const url = `http://${host}:${port}/?t=${server.token}`;
  trace(`serving ${url}`);

  // 4. Point the TV at it.
  progress.report({ message: 'Opening the TV browser…' });
  try {
    await ssap.openUrl(url);
  } catch (err) {
    capture.stop();
    await server.close();
    throw err;
  }
  ssap.toast('Screen cast started from VS Code').catch(() => undefined);

  // 5. Stop the TV sleeping on us. Best effort: a set that refuses the pointer
  //    channel still casts, it just may hit its own screensaver.
  let keepAwake: KeepAwake | undefined;
  if (c.get<boolean>('keepAwake', true)) {
    keepAwake = new KeepAwake(ssap, Math.max(10, c.get<number>('keepAwakeIntervalSeconds', 60)) * 1000);
    keepAwake.on('log', trace);
    keepAwake.on('degraded', (why: string) =>
      void vscode.window.showWarningMessage(
        `Casting, but this TV would not accept the keep-awake nudge (${why}). ` +
          'If the screen sleeps, turn off Screen Saver / Auto Power Off on the TV.'
      )
    );
    await keepAwake.start();
  }

  session = { tv, ssap, capture, server, keepAwake, url };
  server.on('viewers', updateStatus);
  updateStatus();

  void vscode.window
    .showInformationMessage(`Casting to ${tv.name}.`, 'Stop', 'Copy URL')
    .then((action) => {
      if (action === 'Stop') {
        void stopCast('Stopped casting.');
      } else if (action === 'Copy URL') {
        void vscode.env.clipboard.writeText(url);
      }
    });
}

async function listenWithFallback(server: StreamServer, wanted: number): Promise<number> {
  for (let port = wanted; port < wanted + 10; port++) {
    try {
      return await server.listen(port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw err;
      }
      trace(`port ${port} in use, trying ${port + 1}`);
    }
  }
  throw new Error(`No free port in ${wanted}-${wanted + 9}.`);
}

async function stopCast(message?: string): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage('Not casting.');
    return;
  }
  await teardown();
  if (message) {
    void vscode.window.showInformationMessage(message);
  }
}

async function teardown(): Promise<void> {
  const current = session;
  session = undefined;
  status?.hide();
  if (!current) {
    return;
  }
  trace('tearing down');
  current.keepAwake?.stop();
  current.capture.stop();
  await current.server.close();
  if (cfg().get<boolean>('closeBrowserOnStop', true) && current.ssap.connected) {
    await current.ssap.closeBrowser().catch(() => undefined);
  }
  current.ssap.close();
}

async function forget(context: vscode.ExtensionContext): Promise<void> {
  const last = context.globalState.get<Tv>(LAST_TV);
  const manual = cfg().get<string>('tvAddress');
  const addresses = new Set([last?.address, manual].filter(Boolean) as string[]);
  for (const address of addresses) {
    await context.secrets.delete(keySecret(address));
  }
  await context.globalState.update(LAST_TV, undefined);
  void vscode.window.showInformationMessage('Forgot the paired webOS TV.');
}

async function openLocalPreview(): Promise<void> {
  if (!session) {
    void vscode.window.showInformationMessage('Start casting first.');
    return;
  }
  const port = new URL(session.url).port;
  await vscode.env.openExternal(
    vscode.Uri.parse(`http://127.0.0.1:${port}/?t=${session.server.token}`)
  );
}

// --- helpers ----------------------------------------------------------------

function updateStatus(): void {
  if (!session) {
    status.hide();
    return;
  }
  const live = session.server.viewerCount > 0;
  status.text = `${live ? '$(radio-tower)' : '$(sync~spin)'} ${session.tv.name}`;
  status.tooltip = live
    ? `Casting to ${session.tv.name}. Click to stop.`
    : `Waiting for ${session.tv.name} to open the stream. Click to stop.`;
  status.show();
}

async function resolveTv(context: vscode.ExtensionContext): Promise<Tv> {
  const configured = cfg().get<string>('tvAddress')?.trim();
  if (configured) {
    return { address: configured, name: configured };
  }

  const last = context.globalState.get<Tv>(LAST_TV);
  const found = await discover();
  trace(`discovery found ${found.length} device(s)`);

  if (found.length === 1 && (!last || found[0].address === last.address)) {
    return found[0];
  }
  if (found.length === 0 && last) {
    return last;
  }
  return pickTv(found, last);
}

async function pickTv(found: DiscoveredTv[], last?: Tv): Promise<Tv> {
  const items: (vscode.QuickPickItem & { tv?: Tv })[] = found.map((tv) => ({
    label: tv.name,
    description: tv.address,
    detail: tv.address === last?.address ? 'Last used' : undefined,
    tv
  }));
  if (last && !found.some((f) => f.address === last.address)) {
    items.push({ label: last.name, description: last.address, detail: 'Last used (offline?)', tv: last });
  }
  items.push({ label: '$(edit) Enter an IP address…' });

  const picked = await vscode.window.showQuickPick(items, {
    title: found.length ? 'Select a webOS TV' : 'No webOS TV found on the network',
    placeHolder: 'Pick a TV, or enter its IP address'
  });
  if (!picked) {
    throw new Error('Cancelled.');
  }
  if (picked.tv) {
    return picked.tv;
  }

  const entered = await vscode.window.showInputBox({
    title: 'webOS TV address',
    prompt: 'IP address of the TV (Settings > Network on the TV shows it)',
    value: last?.address,
    validateInput: (v) =>
      /^\d{1,3}(\.\d{1,3}){3}$/.test(v.trim()) ? undefined : 'Enter an IPv4 address, e.g. 192.168.1.42'
  });
  if (!entered) {
    throw new Error('Cancelled.');
  }
  return { address: entered.trim(), name: entered.trim() };
}
