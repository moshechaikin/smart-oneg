import { describe, it, expect } from 'vitest';
import { tpiChecksum, tpiFrame, EnvisalinkClient } from '../../server/envisalink/EnvisalinkClient.js';
import { EnvisalinkProvider } from '../../server/devices/EnvisalinkProvider.js';

describe('EnvisaLink TPI', () => {
  it('computes the DSC checksum and frames a command', () => {
    // '001' -> 0x30+0x30+0x31 = 0x91
    expect(tpiChecksum('001')).toBe('91');
    expect(tpiFrame('001')).toBe('00191\r\n');
    expect(tpiFrame('005', '1234')).toMatch(/^0051234[0-9A-F]{2}\r\n$/);
  });

  it('parses partition status frames and emits state changes', () => {
    const c = new EnvisalinkClient({ partition: 1 });
    const states = [];
    c.on('partition', (e) => states.push(`${e.partition}:${e.state}`));
    const line = (cmd, data) => `${cmd}${data}${tpiChecksum(`${cmd}${data}`)}\r\n`;
    c.receive(line('655', '1')); // partition 1 disarmed
    c.receive(line('652', '1')); // partition 1 armed
    c.receive(line('652', '1')); // duplicate — no repeat event
    expect(states).toEqual(['1:disarmed', '1:armed']);
    expect(c.partitionState(1)).toBe('armed');
  });

  it('reaches connected after a login-success frame', () => {
    const c = new EnvisalinkClient({ password: 'user' });
    c.receive(`5053${tpiChecksum('5053')}\r\n`); // login: password requested
    // without a socket, #write is a no-op; assert login state instead via success frame
    c.receive(`5051${tpiChecksum('5051')}\r\n`); // login success
    expect(c.connected).toBe(true);
  });

  it('arms, disarms and bypasses through setLevel (mock provider)', async () => {
    const p = new EnvisalinkProvider({ mock: true, partition: 1, code: '1234' });
    await p.connect();
    const events = [];
    p.on('zoneLevel', (e) => events.push(`${e.id}=${e.level}`));

    await p.setLevel('partition:1', 100);
    expect(await p.queryLevel('partition:1')).toBe(100);
    await p.setLevel('partition:1', 0);
    expect(await p.queryLevel('partition:1')).toBe(0);

    await p.setLevel('bypass:3', 100);
    expect(await p.queryLevel('bypass:3')).toBe(100);
    await p.setLevel('bypass:3', 100); // idempotent — no double-toggle
    expect(await p.queryLevel('bypass:3')).toBe(100);
    await p.setLevel('bypass:3', 0);
    expect(await p.queryLevel('bypass:3')).toBe(0);

    expect(events).toContain('partition:1=100');
    expect(events).toContain('bypass:3=100');
    expect(events).toContain('bypass:3=0');
  });
});
