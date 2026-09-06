import * as fs from 'fs';
import * as path from 'path';

export type Env = Record<string, string>;

function envPath(dir: string): string {
  return path.join(dir, '.env');
}

/** Minimal .env reader. Deliberately dependency-free. */
export function loadEnv(dir: string): Env {
  const file = envPath(dir);
  if (!fs.existsSync(file)) {
    return {};
  }
  const env: Env = {};
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * Writes one key back to .env, updating in place so comments and unrelated
 * lines survive. Used to persist the client key after pairing, so nobody has
 * to copy it out of a terminal by hand.
 */
export function setEnvValue(dir: string, key: string, value: string): void {
  const file = envPath(dir);
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      lines[i] = `${key}=${value}`;
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('');
    }
    lines.push(`${key}=${value}`);
  }
  let out = lines.join('\n');
  if (!out.endsWith('\n')) {
    out += '\n';
  }
  fs.writeFileSync(file, out, 'utf8');
}
