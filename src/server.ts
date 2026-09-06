import * as crypto from 'crypto';
import * as http from 'http';
import { EventEmitter } from 'events';
import { ScreenCapture } from './capture';

const BOUNDARY = 'weboscastframe';

interface Client {
  res: http.ServerResponse;
  saturated: boolean;
  dropped: number;
}

/**
 * Serves the capture as `multipart/x-mixed-replace` MJPEG, with a single-frame
 * endpoint the page falls back to if the browser will not render the multipart
 * stream in an <img>.
 *
 * MJPEG rather than WebRTC on purpose: the webOS browser ranges from Chromium
 * 38 to 120+ depending on model year, and an <img> tag works on all of them.
 */
export class StreamServer extends EventEmitter {
  private server?: http.Server;
  private clients = new Set<Client>();
  private lastFrame?: Buffer;
  private polls = 0;
  readonly token = crypto.randomBytes(9).toString('base64url');

  constructor(private readonly capture: ScreenCapture) {
    super();
    this.capture.on('frame', (frame: Buffer) => {
      this.lastFrame = frame;
      this.broadcast(frame);
    });
  }

  listen(port: number, host = '0.0.0.0'): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handle(req, res));
      server.on('error', reject);
      // TV browsers hold the stream socket open indefinitely; that is the point.
      server.timeout = 0;
      server.headersTimeout = 0;
      server.requestTimeout = 0;
      server.listen(port, host, () => {
        server.off('error', reject);
        server.on('error', (err) => this.emit('log', `server error: ${err.message}`));
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : port);
      });
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const from = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
    const agent = req.headers['user-agent'] ?? '';

    // Every request is logged, including rejected ones. Without this a bad
    // token or an unexpected path is invisible and looks like a hang.
    const done = (status: number, note = '') =>
      this.emit('log', `${from} ${req.method} ${url.pathname} -> ${status}${note ? ' ' + note : ''}`);

    if (url.searchParams.get('t') !== this.token) {
      // Anyone on the LAN could otherwise pull a live view of the screen.
      const given = url.searchParams.get('t');
      done(403, given ? `(stale token "${given}" - reopen the page)` : '(no token)');
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('forbidden: bad or missing token');
      return;
    }

    switch (url.pathname) {
      case '/stream':
        done(200, `mjpeg ${agent ? `ua="${String(agent).slice(0, 90)}"` : ''}`);
        this.addClient(req, res);
        return;

      case '/frame.jpg': {
        // Polling fallback: one JPEG per request.
        if (!this.lastFrame) {
          done(503, 'no frame yet');
          res.writeHead(503, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
          res.end('no frame yet');
          return;
        }
        // Polling runs ~12x/sec, so log the first hit and then only rarely.
        if (this.polls === 0) {
          done(200, `polling fallback in use ${agent ? `ua="${String(agent).slice(0, 90)}"` : ''}`);
        } else if (this.polls % 200 === 0) {
          done(200, `polling fallback, ${this.polls} frames served`);
        }
        this.polls++;
        res.writeHead(200, {
          'content-type': 'image/jpeg',
          'content-length': this.lastFrame.length,
          'cache-control': 'no-store, no-cache, must-revalidate'
        });
        res.end(this.lastFrame);
        return;
      }

      case '/health':
        done(200);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(
          JSON.stringify({
            frames: this.capture.frameCount,
            hasFrame: Boolean(this.lastFrame),
            lastFrameBytes: this.lastFrame?.length ?? 0,
            viewers: this.clients.size,
            polls: this.polls
          })
        );
        return;

      case '/':
        done(200, agent ? `ua="${String(agent).slice(0, 90)}"` : '');
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store'
        });
        res.end(page(this.token));
        return;

      default:
        done(404);
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
    }
  }

  private addClient(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': `multipart/x-mixed-replace; boundary=${BOUNDARY}`,
      'cache-control': 'no-store, no-cache, must-revalidate',
      pragma: 'no-cache'
    });

    const client: Client = { res, saturated: false, dropped: 0 };
    this.clients.add(client);
    this.emit('log', `viewer connected (${this.clients.size} total)`);
    this.emit('viewers', this.clients.size);

    // Send the newest frame immediately so a viewer joining between frames
    // gets a picture now rather than after the next capture tick.
    if (this.lastFrame) {
      this.writeFrame(client, this.lastFrame);
    }

    res.on('drain', () => {
      client.saturated = false;
    });

    const remove = () => {
      if (this.clients.delete(client)) {
        this.emit('log', `viewer disconnected (${client.dropped} frames dropped)`);
        this.emit('viewers', this.clients.size);
      }
    };
    req.on('close', remove);
    res.on('close', remove);
    res.on('error', remove);
  }

  private writeFrame(client: Client, frame: Buffer): void {
    const header = Buffer.from(
      `--${BOUNDARY}\r\nContent-Type: image/jpeg\r\nContent-Length: ${frame.length}\r\n\r\n`,
      'ascii'
    );
    const ok = client.res.write(header) && client.res.write(frame) && client.res.write('\r\n');
    if (!ok) {
      client.saturated = true;
    }
  }

  private broadcast(frame: Buffer): void {
    for (const client of this.clients) {
      // Drop rather than queue: a slow TV must not grow the heap without bound.
      if (client.saturated) {
        client.dropped++;
        continue;
      }
      this.writeFrame(client, frame);
    }
  }

  get viewerCount(): number {
    return this.clients.size;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      try {
        client.res.destroy();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function page(token: string): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>VS Code Screen Cast</title>
<style>
  html, body { margin: 0; height: 100%; background: #000; overflow: hidden; cursor: none; }
  #shot { width: 100%; height: 100%; object-fit: contain; display: block; }
  #status {
    position: fixed; inset: 0;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: #9aa0a6; font: 500 30px/1.5 system-ui, -apple-system, Arial, sans-serif;
    background: #000; text-align: center; padding: 0 6vw;
  }
  #status small { display: block; margin-top: 18px; font-size: 20px; color: #5f6368; }
  #status[hidden] { display: none; }
</style>
</head>
<body>
<img id="shot" alt="">
<div id="status">Connecting to VS Code&hellip;<small id="detail"></small></div>
<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var shot = document.getElementById('shot');
  var status = document.getElementById('status');
  var detail = document.getElementById('detail');

  var mode = 'mjpeg';
  var frames = 0;
  var watchdog = null;
  var retry = null;

  function say(text, sub) {
    status.hidden = false;
    status.firstChild.nodeValue = text;
    detail.textContent = sub || '';
  }

  function url(path) {
    return path + '?t=' + encodeURIComponent(TOKEN) + '&_=' + Date.now();
  }

  function clearTimers() {
    if (watchdog) { clearTimeout(watchdog); watchdog = null; }
    if (retry) { clearTimeout(retry); retry = null; }
  }

  function startMjpeg() {
    clearTimers();
    mode = 'mjpeg';
    say('Connecting to VS Code\\u2026', 'multipart stream');
    shot.src = url('/stream');
    // If the browser will not render multipart/x-mixed-replace in an <img>,
    // it neither loads nor errors -- it just hangs. Time it out and poll.
    watchdog = setTimeout(function () {
      if (frames === 0) { startPolling('stream did not render'); }
    }, 5000);
  }

  function startPolling(why) {
    clearTimers();
    mode = 'poll';
    say('Connecting to VS Code\\u2026', 'polling mode (' + why + ')');
    pollOnce();
  }

  function pollOnce() {
    shot.src = url('/frame.jpg');
  }

  shot.onload = function () {
    frames++;
    clearTimers();
    status.hidden = true;
    if (mode === 'poll') {
      // ~12 fps; the TV decodes a whole JPEG per tick in this mode.
      retry = setTimeout(pollOnce, 80);
    }
  };

  shot.onerror = function () {
    clearTimers();
    shot.removeAttribute('src');
    if (mode === 'mjpeg' && frames === 0) {
      startPolling('stream request failed');
      return;
    }
    // Casting stopped, or the key rotated. Keep trying so restarting in
    // VS Code picks the picture back up without touching the TV.
    say('Reconnecting to VS Code\\u2026', 'frames received: ' + frames);
    retry = setTimeout(mode === 'poll' ? pollOnce : startMjpeg, 2000);
  };

  startMjpeg();
})();
</script>
</body>
</html>`;
}
