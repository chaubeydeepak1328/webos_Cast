# Cast to webOS TV

Mirror your screen to an LG webOS TV from inside VS Code, over your LAN.

VS Code cannot act as a Miracast source — that is an OS-level radio stack with no
Node API. Instead this extension does the two things that *are* reachable from an
extension host:

1. **Control channel** — talks LG's SSAP protocol over WebSocket to the TV and
   tells it to open a URL in its built-in browser.
2. **Pixel channel** — runs ffmpeg to capture the desktop and serves it from a
   local HTTP server as MJPEG, which that browser then displays fullscreen.

MJPEG rather than WebRTC on purpose: the webOS browser ranges from Chromium 38 to
120+ depending on model year, and an `<img>` tag works on every one of them.
Latency on a LAN is roughly 100–300 ms. On a 2023+ set, WebRTC is a viable later
upgrade for lower latency and audio.

## Quick start

Requires **ffmpeg** on PATH (or set `FFMPEG_PATH`). The TV must be on the same
network as this machine.

```
npm install
npm run doctor    # preflight: ffmpeg, network, TV, capture. Touches nothing.
npm run pair      # raises the prompt on the TV; writes the key into .env
npm run cast      # casts from the terminal. Ctrl+C to stop.
```

`npm run doctor` and `npm run cast` are the fastest way to test the pipeline —
they run everything the extension does, without the Extension Development Host.

For the extension itself, press <kbd>F5</kbd>, then run **webOS: Cast to webOS TV**
from the command palette. It picks up the key `npm run pair` wrote to `.env`, so
you only ever pair once.

## Configuration

Copy `.env.example` to `.env`. Every value is optional — the IP is discovered over
SSDP and the pairing key is written by `npm run pair`.

| Variable | Purpose |
| --- | --- |
| `WEBOS_TV_IP` | TV address. Blank = discover via SSDP. |
| `WEBOS_CLIENT_KEY` | Pairing key. **Written for you** by `npm run pair`. |
| `LOCAL_LAN_IP` | Address advertised to the TV. Blank = auto-detect. |
| `WEBOS_PORT` | Local stream port (default 7337). |
| `WEBOS_FRAMERATE` / `WEBOS_WIDTH` / `WEBOS_QUALITY` / `WEBOS_MONITOR` | Capture tuning. |
| `FFMPEG_PATH` | If ffmpeg is not on PATH. |

`.env` is gitignored. The pairing key is a credential for controlling your TV —
keep it out of version control.

## Use

- **webOS: Cast to webOS TV** — discovers TVs via SSDP, pairs, starts casting.
  The first run shows a prompt on the TV that you must accept with the remote;
  the returned client key is stored in VS Code's secret storage, so every later
  run connects silently.
- **webOS: Stop Casting** — or click the status bar item.
- **webOS: Pair with TV** — forces a fresh pairing prompt.
- **webOS: Forget Paired TV** — clears the stored key.
- **webOS: Open Stream Preview Locally** — opens the same stream in your local
  browser, for checking the pipeline without looking at the TV.
- **webOS: Show Log** — the output channel, including the exact ffmpeg command.

The status bar shows a spinner while waiting for the TV to open the stream and a
tower icon once it is actually pulling frames.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `webosCast.tvAddress` | `""` | Skip discovery and use this IP. |
| `webosCast.port` | `7337` | Local stream port; falls forward if busy. |
| `webosCast.bindAddress` | `""` | LAN IP to advertise. Auto-detects the adapter on the TV's subnet. |
| `webosCast.framerate` | `15` | 10–15 is plenty for a desk screen. |
| `webosCast.width` | `1280` | Height follows aspect ratio. |
| `webosCast.quality` | `6` | ffmpeg `-q:v`; 2 = best, 31 = worst. |
| `webosCast.ffmpegPath` | `ffmpeg` | |
| `webosCast.captureMethod` | `auto` | `ddagrab`/`gdigrab`/`avfoundation`/`x11grab`. |
| `webosCast.monitor` | `0` | Which display to capture. |
| `webosCast.closeBrowserOnStop` | `true` | Close the TV browser when casting stops. |

At the defaults, expect roughly 6–10 Mbit/s on the wire.

## Verified on

LG 43NU870BPLA (2026, webOS 25/26, Alpha7 Gen9). Discovery, control channel,
capture and streaming confirmed working. That set accepts `wss://:3001` only and
resets the connection on `:3000`, which is why the client tries both.

## Design notes

**Port fallback.** Older sets accept `ws://<tv>:3000`; webOS 23+ and some newer
firmware only accept `wss://<tv>:3001` with a self-signed certificate. The client
tries both.

**Capture backend.** On Windows, `ddagrab` (D3D11 Desktop Duplication) is far
cheaper than `gdigrab`, but needs ffmpeg ≥ 6 and a working D3D11 device. `auto`
tries it, waits for a real first frame, and falls back to `gdigrab` if none
arrives — a backend that starts and then dies counts as a failure.

**LAN address.** Windows dev machines routinely have Hyper-V, WSL, Docker and VPN
adapters that sort ahead of the real NIC, so "first IPv4" gets you an address the
TV cannot reach. The extension picks the adapter on the TV's own subnet.

**Access control.** The stream URL carries a random token; requests without it get
a 403. Without that, anything on the LAN could pull a live view of your screen.

**Backpressure.** Frames are dropped, never queued, when a viewer's socket is
saturated, so a slow TV cannot grow the extension host's heap.

## Limits

- **No audio.** MJPEG is video-only. Audio needs a second transport, which
  reintroduces the old-Chromium problem.
- **Pairing is interactive.** Someone has to press OK on the TV the first time.
  There is no way around this.
- **Registration manifest.** The well-known LG remote manifest also carries a
  `signatures` blob. webOS does not appear to verify it and it is omitted here
  rather than shipped as an unverifiable constant. If a particular set refuses to
  register, that block is the first thing to add back (`src/ssap.ts`).

## Possible next step

Instead of the TV's browser, ship a real webOS app: enable Developer Mode on the
TV, then `ares-package` / `ares-install` / `ares-launch` an `.ipk` that fullscreens
the same stream. That drops the browser chrome and gives you a persistent
WebSocket back to VS Code. The tradeoff is that Developer Mode sessions expire and
need periodic renewal from the TV's Developer Mode app.
