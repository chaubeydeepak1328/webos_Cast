import * as os from 'os';

export interface LanIface {
  address: string;
  netmask: string;
  name: string;
}

/** Every non-internal IPv4 address on this machine. */
export function lanInterfaces(): LanIface[] {
  const out: LanIface[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const i of infos ?? []) {
      if (i.family !== 'IPv4' || i.internal) {
        continue;
      }
      out.push({ address: i.address, netmask: i.netmask, name });
    }
  }
  return out;
}

function toInt(ip: string): number {
  const p = ip.split('.').map((n) => parseInt(n, 10));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return NaN;
  }
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}

function sameSubnet(a: LanIface, target: string): boolean {
  const mask = toInt(a.netmask);
  const self = toInt(a.address);
  const other = toInt(target);
  if ([mask, self, other].some(Number.isNaN)) {
    return false;
  }
  return ((self & mask) >>> 0) === ((other & mask) >>> 0);
}

/**
 * The address the TV should connect back to.
 *
 * Windows dev machines routinely have Hyper-V, WSL, VPN and Docker adapters that
 * sort ahead of the real NIC, so picking "the first IPv4" gets you an address the
 * TV cannot reach. Matching the TV's own subnet is the only reliable heuristic.
 */
export function bestLanAddress(tvAddress?: string): string | undefined {
  const ifaces = lanInterfaces();
  if (ifaces.length === 0) {
    return undefined;
  }
  if (tvAddress) {
    const match = ifaces.find((i) => sameSubnet(i, tvAddress));
    if (match) {
      return match.address;
    }
  }
  const physical = ifaces.filter(
    (i) => !/^(vEthernet|Loopback|VirtualBox|VMware|Hyper-V|WSL|Tailscale|ZeroTier)/i.test(i.name)
  );
  return (physical[0] ?? ifaces[0]).address;
}
