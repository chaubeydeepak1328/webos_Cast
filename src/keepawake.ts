import { EventEmitter } from 'events';
import { PointerInput, SsapClient } from './ssap';

/**
 * Stops the TV falling asleep mid-cast.
 *
 * A cast is a page of still <img> frames as far as webOS is concerned: no
 * remote presses, and (without help) no media playback either, so the set
 * runs its screensaver and then blanks the panel while the stream is still
 * perfectly healthy underneath.
 *
 * Two independent defences, because which one works depends on the model:
 *   - here: a zero-delta pointer move every interval, which the TV counts as
 *     user input and which resets the system idle timer;
 *   - in the served page: a muted looping video, which marks the tab as
 *     playing media and suppresses the browser-level screensaver.
 *
 * Neither can override an explicit Sleep Timer or "Auto Power Off" setting on
 * the TV -- those are deliberate and are left alone.
 */
export class KeepAwake extends EventEmitter {
  private pointer?: PointerInput;
  private timer?: NodeJS.Timeout;
  private stopped = false;
  private failures = 0;
  private complained = false;

  constructor(
    private readonly ssap: SsapClient,
    private readonly intervalMs: number
  ) {
    super();
  }

  /**
   * Never throws: a TV that refuses the pointer channel should still cast,
   * just without this protection.
   */
  async start(): Promise<void> {
    // If the panel is already blank, casting to it is pointless. Best effort:
    // older sets have no tvpower service and reject this outright.
    await this.ssap.turnOnScreen().catch((err: Error) => {
      this.emit('log', `keep-awake: could not wake the screen (${err.message}); continuing`);
    });

    try {
      this.pointer = await this.ssap.pointerInput();
      this.emit('log', `keep-awake: nudging the TV every ${Math.round(this.intervalMs / 1000)}s`);
    } catch (err) {
      this.emit('log', `keep-awake: pointer channel unavailable (${(err as Error).message})`);
      this.emit('degraded', (err as Error).message);
      return;
    }

    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      if (!this.pointer?.connected) {
        // The TV drops this socket on app switches and after long idles.
        this.pointer?.close();
        this.pointer = await this.ssap.pointerInput();
        this.emit('log', 'keep-awake: pointer channel reopened');
      }
      this.pointer.nudge();
      if (this.failures > 0) {
        this.emit('log', `keep-awake: recovered after ${this.failures} failed nudge(s)`);
        this.failures = 0;
        this.complained = false;
      }
    } catch (err) {
      this.failures++;
      this.emit('log', `keep-awake: nudge failed (${(err as Error).message}), attempt ${this.failures}`);
      // Warn once. Beyond this the stream still works; only sleep is at risk,
      // so keep retrying quietly rather than tearing the cast down.
      if (this.failures >= 3 && !this.complained) {
        this.complained = true;
        this.emit('degraded', (err as Error).message);
      }
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.pointer?.close();
    this.pointer = undefined;
  }
}
