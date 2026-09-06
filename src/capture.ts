import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { EventEmitter } from 'events';

export type CaptureMethod = 'auto' | 'ddagrab' | 'gdigrab' | 'avfoundation' | 'x11grab';

export interface CaptureOptions {
  ffmpegPath: string;
  method: CaptureMethod;
  framerate: number;
  width: number;
  quality: number;
  monitor: number;
}

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);
const MAX_BUFFER = 32 * 1024 * 1024;

function resolveMethods(method: CaptureMethod): Exclude<CaptureMethod, 'auto'>[] {
  if (method !== 'auto') {
    return [method];
  }
  switch (process.platform) {
    case 'win32':
      // ddagrab (Desktop Duplication) is far cheaper than gdigrab, but needs
      // ffmpeg >= 6 and a D3D11 device, so keep gdigrab as the safety net.
      return ['ddagrab', 'gdigrab'];
    case 'darwin':
      return ['avfoundation'];
    default:
      return ['x11grab'];
  }
}

function buildArgs(method: Exclude<CaptureMethod, 'auto'>, o: CaptureOptions): string[] {
  const post = ['-c:v', 'mjpeg', '-q:v', String(o.quality), '-f', 'mjpeg', '-'];
  const scale = `scale=${o.width}:-2:flags=fast_bilinear,format=yuvj420p`;
  const base = ['-hide_banner', '-loglevel', 'error', '-nostdin'];

  switch (method) {
    case 'ddagrab':
      return [
        ...base,
        '-filter_complex',
        `ddagrab=output_idx=${o.monitor}:framerate=${o.framerate},hwdownload,format=bgra,${scale}`,
        ...post
      ];
    case 'gdigrab':
      return [
        ...base,
        '-f', 'gdigrab',
        '-framerate', String(o.framerate),
        '-i', 'desktop',
        '-vf', scale,
        ...post
      ];
    case 'avfoundation':
      return [
        ...base,
        '-f', 'avfoundation',
        '-capture_cursor', '1',
        '-framerate', String(o.framerate),
        '-i', `${o.monitor}:none`,
        '-vf', scale,
        ...post
      ];
    case 'x11grab':
      return [
        ...base,
        '-f', 'x11grab',
        '-framerate', String(o.framerate),
        '-i', `:0.${o.monitor}`,
        '-vf', scale,
        ...post
      ];
  }
}

/**
 * Runs ffmpeg and emits complete JPEG frames.
 *
 * Events: `frame` (Buffer), `log` (string), `started` (method), `error` (Error).
 */
export class ScreenCapture extends EventEmitter {
  private proc?: ChildProcessWithoutNullStreams;
  private buf: Buffer = Buffer.alloc(0);
  private eoiSearchFrom = 0;
  private frames = 0;
  private stopping = false;

  constructor(private readonly opts: CaptureOptions) {
    super();
  }

  async start(): Promise<void> {
    const methods = resolveMethods(this.opts.method);
    const failures: string[] = [];
    for (const method of methods) {
      try {
        await this.tryStart(method);
        this.emit('started', method);
        return;
      } catch (err) {
        failures.push(`${method}: ${(err as Error).message}`);
        this.emit('log', `capture via ${method} failed - ${(err as Error).message}`);
      }
    }
    throw new Error(`Screen capture failed.\n${failures.join('\n')}`);
  }

  /**
   * Resolves once the first frame arrives, so a backend that starts but then
   * dies (the usual ddagrab failure) is treated as a failure and falls through.
   */
  private tryStart(method: Exclude<CaptureMethod, 'auto'>): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = buildArgs(method, this.opts);
      this.emit('log', `spawning: ${this.opts.ffmpegPath} ${args.join(' ')}`);

      let proc: ChildProcessWithoutNullStreams;
      try {
        proc = spawn(this.opts.ffmpegPath, args, { windowsHide: true });
      } catch (err) {
        reject(err as Error);
        return;
      }
      this.proc = proc;
      this.buf = Buffer.alloc(0);
      this.eoiSearchFrom = 0;
      this.frames = 0;

      let settled = false;
      let stderr = '';

      const fail = (err: Error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          proc.kill();
        } catch {
          /* already dead */
        }
        reject(err);
      };

      const timer = setTimeout(() => {
        fail(new Error(`no frames within 8s${stderr ? ` - ${stderr.trim().split('\n').pop()}` : ''}`));
      }, 8000);
      timer.unref?.();

      proc.stdout.on('data', (chunk: Buffer) => {
        this.consume(chunk);
        if (!settled && this.frames > 0) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      });

      proc.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        stderr = (stderr + text).slice(-4000);
        this.emit('log', `ffmpeg: ${text.trim()}`);
      });

      proc.on('error', (err) => fail(err));

      proc.on('close', (code) => {
        if (!settled) {
          fail(new Error(`ffmpeg exited (${code})${stderr ? ` - ${stderr.trim().split('\n').pop()}` : ''}`));
          return;
        }
        if (!this.stopping) {
          this.emit('error', new Error(`ffmpeg stopped unexpectedly (exit ${code})`));
        }
      });
    });
  }

  /**
   * Splits ffmpeg's MJPEG stream on SOI/EOI markers. ffmpeg byte-stuffs FF in
   * entropy-coded data and writes no thumbnails, so a bare marker scan is safe
   * here even though it would not be for arbitrary JPEG sources.
   */
  private consume(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);

    for (;;) {
      const start = this.buf.indexOf(SOI);
      if (start < 0) {
        // Nothing usable buffered; keep only a marker's worth of tail.
        this.buf = this.buf.subarray(Math.max(0, this.buf.length - 1));
        this.eoiSearchFrom = 0;
        break;
      }
      if (start > 0) {
        this.buf = this.buf.subarray(start);
        this.eoiSearchFrom = 0;
      }
      const end = this.buf.indexOf(EOI, Math.max(2, this.eoiSearchFrom));
      if (end < 0) {
        this.eoiSearchFrom = Math.max(2, this.buf.length - 1);
        break;
      }
      const frame = this.buf.subarray(0, end + 2);
      this.buf = this.buf.subarray(end + 2);
      this.eoiSearchFrom = 0;
      this.frames++;
      this.emit('frame', frame);
    }

    if (this.buf.length > MAX_BUFFER) {
      this.emit('log', 'frame buffer overflow, resyncing');
      this.buf = Buffer.alloc(0);
      this.eoiSearchFrom = 0;
    }
  }

  get frameCount(): number {
    return this.frames;
  }

  stop(): void {
    this.stopping = true;
    const proc = this.proc;
    this.proc = undefined;
    if (!proc) {
      return;
    }
    try {
      proc.stdout.destroy();
      proc.stderr.destroy();
      proc.kill();
      // ffmpeg occasionally ignores SIGTERM when a capture device is wedged.
      const t = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 2000);
      t.unref?.();
    } catch {
      /* already dead */
    }
  }
}
