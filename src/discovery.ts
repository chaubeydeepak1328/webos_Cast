import * as dgram from 'dgram';
import * as http from 'http';

export interface DiscoveredTv {
  address: string;
  name: string;
}

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const ST = 'urn:lge-com:service:webos-second-screen:1';

/** SSDP M-SEARCH for webOS second-screen devices. */
export function discover(timeoutMs = 3000): Promise<DiscoveredTv[]> {
  return new Promise((resolve) => {
    const found = new Map<string, string | undefined>();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

    const finish = async () => {
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      const tvs = await Promise.all(
        [...found.entries()].map(async ([address, location]) => ({
          address,
          name: (location ? await friendlyName(location) : undefined) ?? `webOS TV (${address})`
        }))
      );
      resolve(tvs.sort((a, b) => a.name.localeCompare(b.name)));
    };

    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();

    socket.on('error', () => {
      clearTimeout(timer);
      void finish();
    });

    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8');
      if (!/^HTTP\/1\.1 200/i.test(text)) {
        return;
      }
      const location = /^location:\s*(.+)$/im.exec(text)?.[1]?.trim();
      if (!found.has(rinfo.address)) {
        found.set(rinfo.address, location);
      }
    });

    socket.bind(() => {
      const search = [
        'M-SEARCH * HTTP/1.1',
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
        'MAN: "ssdp:discover"',
        'MX: 2',
        `ST: ${ST}`,
        '',
        ''
      ].join('\r\n');
      const buf = Buffer.from(search, 'utf8');
      // Datagrams get dropped; a handful of retries costs nothing.
      for (const delay of [0, 250, 700]) {
        const t = setTimeout(() => {
          try {
            socket.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR);
          } catch {
            /* socket closed early */
          }
        }, delay);
        t.unref?.();
      }
    });
  });
}

function friendlyName(location: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = http.get(location, { timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (body.length < 64 * 1024) {
          body += c;
        }
      });
      res.on('end', () => resolve(/<friendlyName>([^<]+)<\/friendlyName>/i.exec(body)?.[1]?.trim()));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(undefined));
  });
}
