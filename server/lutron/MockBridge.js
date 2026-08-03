import net from 'node:net';
import { EventEmitter } from 'node:events';

/**
 * In-process Lutron Smart Bridge Pro simulator speaking the GNET/LIP telnet
 * dialect: login/password prompts, GNET> prompt, #OUTPUT / ?OUTPUT handling,
 * ~OUTPUT monitor lines, ~ERROR replies.
 *
 * Used by the integration tests and by `lutron.mock: true` demo mode.
 * Test controls: simulateManualChange(), rejectAction5, dropConnections(), mute.
 */
export class MockBridge extends EventEmitter {
  /**
   * @param {boolean} promptFirst emulate the REAL Smart Bridge Pro ordering:
   *  GNET> prompt is written immediately, the ~OUTPUT response a few ms later
   *  (verified on hardware 2026-07-06). false = response-then-prompt ordering.
   */
  constructor({ username = 'lutron', password = 'integration', zoneIds = [2, 3, 4, 5, 6, 7, 8, 9, 10], promptFirst = false } = {}) {
    super();
    this.username = username;
    this.password = password;
    this.levels = new Map(zoneIds.map((id) => [id, 0]));
    this.rejectAction5 = false;
    this.mute = false; // true = swallow post-login traffic (simulates a silently dead link)
    this.promptFirst = promptFirst;
    this.sockets = new Set();
    this.commandLog = [];
    this.server = net.createServer((socket) => this.#handle(socket));
  }

  async listen(port = 0) {
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, '127.0.0.1', resolve);
    });
    this.port = this.server.address().port;
    return this.port;
  }

  async close() {
    for (const s of this.sockets) s.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }

  /** Emit a ~OUTPUT as if someone pressed a wall switch. */
  simulateManualChange(id, level) {
    this.levels.set(id, level);
    this.#broadcast(`~OUTPUT,${id},1,${level.toFixed(2)}`);
  }

  /** Abruptly kill all client connections (tests reconnect logic). */
  dropConnections() {
    for (const s of this.sockets) s.destroy();
  }

  #handle(socket) {
    this.sockets.add(socket);
    socket.on('close', () => this.sockets.delete(socket));
    socket.on('error', () => {});
    const state = { phase: 'login', buffer: '' };
    socket.write('login: ');

    socket.on('data', (chunk) => {
      state.buffer += chunk.toString();
      let idx;
      while ((idx = state.buffer.search(/\r\n|\n|\r/)) >= 0) {
        const line = state.buffer.slice(0, idx).trim();
        state.buffer = state.buffer.slice(idx + (state.buffer[idx] === '\r' && state.buffer[idx + 1] === '\n' ? 2 : 1));
        this.#line(socket, state, line);
      }
    });
  }

  #line(socket, state, line) {
    if (state.phase === 'login') {
      state.phase = line === this.username ? 'password' : 'login-bad';
      socket.write('password: ');
      return;
    }
    if (state.phase === 'password' || state.phase === 'login-bad') {
      if (state.phase === 'password' && line === this.password) {
        state.phase = 'ready';
        socket.write('GNET> ');
      } else {
        socket.write('bad login\r\nlogin: ');
        state.phase = 'login';
      }
      return;
    }
    // Silently dead link (Wi-Fi off, cable pulled): the socket stays open but
    // nothing ever comes back — the case the client's keepalive must catch.
    if (this.mute) return;
    if (!line) { socket.write('GNET> '); return; }
    this.commandLog.push(line);
    this.emit('command', line);
    if (this.promptFirst) {
      socket.write('GNET> ');
      setTimeout(() => this.#command(socket, line), 5);
    } else {
      this.#command(socket, line);
      socket.write('GNET> ');
    }
  }

  #command(socket, line) {
    const parts = line.split(',');
    const op = line[0];
    const cmd = parts[0].slice(1).toUpperCase();

    if (cmd !== 'OUTPUT') { socket.write('~ERROR,6\r\n'); return; }
    const id = Number(parts[1]);
    const action = Number(parts[2]);
    if (!this.levels.has(id)) { socket.write('~ERROR,2\r\n'); return; }

    if (op === '#') {
      if (action === 1) {
        const level = Number(parts[3]);
        if (!(level >= 0 && level <= 100)) { socket.write('~ERROR,4\r\n'); return; }
        this.levels.set(id, level);
        this.#broadcast(`~OUTPUT,${id},1,${level.toFixed(2)}`);
      } else if (action === 5 || action === 6) {
        if (this.rejectAction5) { socket.write('~ERROR,6\r\n'); return; }
        this.emit('flash', id);
      } else {
        socket.write('~ERROR,3\r\n');
      }
    } else if (op === '?') {
      if (action !== 1) { socket.write('~ERROR,3\r\n'); return; }
      socket.write(`~OUTPUT,${id},1,${this.levels.get(id).toFixed(2)}\r\n`);
    } else {
      socket.write('~ERROR,6\r\n');
    }
  }

  #broadcast(line) {
    for (const s of this.sockets) s.write(`${line}\r\n`);
  }
}
