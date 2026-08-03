import http from 'node:http';
import os from 'node:os';

const SOCKET = '/var/run/docker.sock';

/**
 * Talk to the Docker Engine API over the mounted unix socket. Returns parsed
 * JSON (or null for empty bodies). Throws on a non-2xx with the body text.
 */
function engine(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const req = http.request({
      socketPath: SOCKET, method, path,
      headers: { 'Content-Type': 'application/json', ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(data ? JSON.parse(data) : null); } catch { resolve(null); }
        } else {
          reject(new Error(`docker ${method} ${path} -> ${res.statusCode} ${data.slice(0, 300)}`));
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// pulling an image streams NDJSON progress; just wait for the stream to end
function pullImage(fromImage, tag = 'latest') {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath: SOCKET, method: 'POST', path: `/images/create?fromImage=${encodeURIComponent(fromImage)}&tag=${encodeURIComponent(tag)}` },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => (res.statusCode < 400 ? resolve() : reject(new Error(`pull ${fromImage}:${tag} -> ${res.statusCode} ${data.slice(0, 200)}`))));
      });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Trigger an in-place update of THIS container by asking Docker (over the
 * socket) to run a one-shot Watchtower against us. Watchtower pulls a newer
 * image for our tag and recreates our container with the same config — the
 * reliable, battle-tested way to do "recreate yourself", which a container
 * can't do to itself directly (its process dies mid-swap).
 *
 * Requires the Docker socket to be mounted (root-equivalent host access), so
 * callers gate this behind an explicit opt-in. Throws if anything is missing;
 * the route falls back to guiding the user through the manual command.
 */
export async function selfUpdate({ logger = null, watchtowerImage = 'containrrr/watchtower' } = {}) {
  // our own container id is the hostname under Docker's default config
  const selfId = os.hostname();
  const self = await engine('GET', `/containers/${selfId}/json`);
  const name = (self?.Name ?? '').replace(/^\//, '');
  if (!name) throw new Error('could not resolve this container (is the Docker socket mounted?)');

  logger?.warn({ container: name }, 'self-update: pulling watchtower and running it once');
  await pullImage(watchtowerImage, 'latest');

  const created = await engine('POST', '/containers/create', {
    Image: `${watchtowerImage}:latest`,
    // run once against just this container, then clean up the watchtower run
    Cmd: ['--run-once', '--cleanup', name],
    HostConfig: {
      AutoRemove: true,
      Binds: [`${SOCKET}:${SOCKET}`],
    },
  });
  if (!created?.Id) throw new Error('failed to create the updater container');
  await engine('POST', `/containers/${created.Id}/start`);
  logger?.warn({ container: name, updater: created.Id }, 'self-update: watchtower started — this instance will be recreated shortly');
  return { container: name };
}
