import { EventEmitter } from 'events';
import WebSocket from 'ws';

/**
 * Manifest sent during registration. webOS shows the app name in the pairing
 * prompt and gates the ssap:// URIs we may call on the permission list.
 *
 * Note: the well-known LG remote manifest also carries a `signatures` block.
 * webOS does not verify it in practice and it is omitted here rather than
 * shipped as an unverifiable blob. If a particular set refuses registration,
 * that block is the first thing to add back.
 */
const MANIFEST = {
  manifestVersion: 1,
  appVersion: '1.0',
  signed: {
    created: '20260101',
    appId: 'com.vscode.webos.cast',
    vendorId: 'com.vscode',
    localizedAppNames: {
      '': 'VS Code Screen Cast'
    },
    localizedVendorNames: {
      '': 'VS Code'
    },
    permissions: ['LAUNCH', 'CONTROL_AUDIO', 'READ_INSTALLED_APPS'],
    serial: '2f930e2d2cfe083771f68e4fe7bb07'
  },
  permissions: [
    'LAUNCH',
    'LAUNCH_WEBAPP',
    'APP_TO_APP',
    'CONTROL_AUDIO',
    'CONTROL_DISPLAY',
    'CONTROL_INPUT_MEDIA_PLAYBACK',
    'READ_INSTALLED_APPS',
    'READ_RUNNING_APPS',
    'WRITE_NOTIFICATION_TOAST',
    'CLOSE'
  ]
};

export interface SsapOptions {
  address: string;
  /** Milliseconds to wait for the on-TV pairing prompt to be accepted. */
  pairTimeoutMs?: number;
}

type Pending = {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
};

export class SsapClient extends EventEmitter {
  private ws?: WebSocket;
  private pending = new Map<string, Pending>();
  private nextId = 1;
  private closed = false;

  constructor(private readonly opts: SsapOptions) {
    super();
  }

  /**
   * Older sets listen on plain ws://:3000. webOS 23+ increasingly only accepts
   * wss://:3001 with a self-signed cert, so try both before giving up.
   */
  async connect(): Promise<void> {
    const candidates = [`ws://${this.opts.address}:3000`, `wss://${this.opts.address}:3001`];
    const errors: string[] = [];
    for (const url of candidates) {
      try {
        this.ws = await this.open(url);
        this.attach(this.ws);
        this.emit('log', `connected to ${url}`);
        return;
      } catch (err) {
        errors.push(`${url}: ${(err as Error).message}`);
      }
    }
    throw new Error(`Could not reach the TV.\n${errors.join('\n')}`);
  }

  private open(url: string): Promise<WebSocket> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        // The TV presents a self-signed certificate on :3001.
        rejectUnauthorized: false,
        handshakeTimeout: 5000
      });
      const onOpen = () => {
        ws.off('error', onError);
        resolve(ws);
      };
      const onError = (err: Error) => {
        ws.off('open', onOpen);
        try {
          ws.terminate();
        } catch {
          /* nothing to tear down */
        }
        reject(err);
      };
      ws.once('open', onOpen);
      ws.once('error', onError);
    });
  }

  private attach(ws: WebSocket): void {
    ws.on('message', (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const entry = msg.id ? this.pending.get(msg.id) : undefined;

      if (msg.type === 'registered' && entry) {
        this.pending.delete(msg.id);
        entry.resolve(msg.payload?.['client-key']);
        return;
      }
      if (msg.type === 'response' && msg.payload?.pairingType === 'PROMPT') {
        // Interim response: the TV is now showing the accept dialog.
        this.emit('prompt');
        return;
      }
      if (!entry) {
        return;
      }
      this.pending.delete(msg.id);
      if (msg.type === 'error' || msg.payload?.returnValue === false) {
        entry.reject(new Error(msg.error || msg.payload?.errorText || 'TV rejected the request'));
      } else {
        entry.resolve(msg.payload);
      }
    });

    ws.on('close', () => {
      this.failAllPending(new Error('Connection to the TV closed'));
      if (!this.closed) {
        this.emit('disconnected');
      }
    });

    ws.on('error', (err) => {
      this.emit('log', `socket error: ${(err as Error).message}`);
    });
  }

  private failAllPending(err: Error): void {
    for (const [, p] of this.pending) {
      p.reject(err);
    }
    this.pending.clear();
  }

  private send(frame: Record<string, unknown>, timeoutMs: number): Promise<any> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Not connected to the TV'));
    }
    const id = String(this.nextId++);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The TV did not respond in time'));
      }, timeoutMs);
      timer.unref?.();

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        }
      });
      ws.send(JSON.stringify({ ...frame, id }));
    });
  }

  /**
   * Registers with the TV. Pass a previously stored client key to reconnect
   * silently; without one the TV shows a prompt the user must accept.
   * Resolves with the client key to persist.
   */
  async register(clientKey?: string): Promise<string> {
    const payload: Record<string, unknown> = {
      forcePairing: false,
      pairingType: 'PROMPT',
      manifest: MANIFEST
    };
    if (clientKey) {
      payload['client-key'] = clientKey;
    }
    const key = await this.send(
      { type: 'register', payload },
      clientKey ? 10000 : (this.opts.pairTimeoutMs ?? 60000)
    );
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('The TV did not return a client key');
    }
    return key;
  }

  request(uri: string, payload?: Record<string, unknown>): Promise<any> {
    return this.send({ type: 'request', uri, payload: payload ?? {} }, 10000);
  }

  /** Opens a URL in the TV's built-in browser. */
  openUrl(url: string): Promise<any> {
    return this.request('ssap://system.launcher/open', { target: url });
  }

  toast(message: string): Promise<any> {
    return this.request('ssap://system.notifications/createToast', { message });
  }

  closeBrowser(): Promise<any> {
    return this.request('ssap://system.launcher/close', { id: 'com.webos.app.browser' });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this.closed = true;
    this.failAllPending(new Error('Client closed'));
    try {
      this.ws?.close();
    } catch {
      /* already gone */
    }
    this.ws = undefined;
  }
}
