import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import type { AddressInfo, Server, Socket } from 'node:net';
import { describe, it } from 'node:test';

import { createModbusUnit } from '../src/actuator/modbus-tcp.ts';
import type { ModbusUnitOptions } from '../src/actuator/modbus-tcp.ts';

/**
 * The only tests here that touch a real socket, and the only ones that wait on a
 * clock. Everything about the protocol is covered against a fake stream in
 * `modbus-tcp.test.ts`; this file covers the eighteen lines of `openTcpStream`
 * that a fake stream cannot reach — connecting, giving up, and noticing that the
 * far end went away.
 *
 * It exists because those eighteen lines turned out to hold three defects while
 * the protocol above them held none.
 */
const BUDGET_MS = 150;

function options(port: number, overrides: Partial<ModbusUnitOptions> = {}): ModbusUnitOptions {
  return {
    host: '127.0.0.1',
    port,
    unitId: 1,
    timeoutMs: BUDGET_MS,
    retries: 0,
    retryPauseMs: 0,
    ...overrides,
  };
}

/** A server on a free port, with a hook for what to do with each connection. */
async function listening(onConnection: (socket: Socket) => void): Promise<Server> {
  const server = createServer(onConnection);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server has no port');
  return (address as AddressInfo).port;
}

describe('talking over a real socket', () => {
  it('completes a round trip against something that answers like the unit', async () => {
    // The whole path, sockets included: connect, write the frame, read the echo,
    // close. Nothing below this line is a fake.
    const server = await listening((socket) => {
      socket.on('data', (request) => void socket.write(request));
    });

    try {
      await createModbusUnit(options(portOf(server))).set(60);
    } finally {
      server.close();
    }
  });

  it('gives up on a connection that is never accepted, inside its budget', async () => {
    // 192.0.2.1 is TEST-NET-1: reserved for documentation and routed nowhere, so
    // the SYN goes unanswered. Left to the operating system this blocks for over
    // a minute; the control loop runs every thirty seconds.
    const unreachable = createModbusUnit({
      host: '192.0.2.1',
      port: 502,
      unitId: 1,
      timeoutMs: BUDGET_MS,
      retries: 0,
      retryPauseMs: 0,
    });

    const startedAt = performance.now();
    await assert.rejects(unreachable.read(), /no connection to 192\.0\.2\.1:502 within 150 ms/);

    assert.ok(
      performance.now() - startedAt < 2_000,
      'the connect attempt was not bounded by the timeout',
    );
  });

  it('fails fast when the unit hangs up cleanly without answering', async () => {
    // How a small embedded stack sheds load: it accepts the connection, sends a
    // FIN and says nothing. That produces no data and no error, so the close
    // event is the only thing that says the socket is gone.
    // It hangs up *after* taking the request, which is both the realistic order
    // and the deterministic one: ending before the write races our own send.
    const server = await listening((socket) => {
      socket.on('data', () => socket.end());
    });

    try {
      const startedAt = performance.now();
      await assert.rejects(createModbusUnit(options(portOf(server))).read(), /closed the connection/);

      assert.ok(
        performance.now() - startedAt < BUDGET_MS,
        'it waited out the whole timeout for a socket that had already gone',
      );
    } finally {
      server.close();
    }
  });

  it('fails fast when the unit resets the connection', async () => {
    // The abrupt version of the same thing, which arrives as an error rather
    // than a close. Both have to be quick; only one of them has an error to go on.
    //
    // resetAndDestroy rather than destroy: plain destroy sends a FIN or an RST
    // depending on whether unread data happens to be buffered, so the test would
    // land in the other case above at random.
    const server = await listening((socket) => {
      socket.on('data', () => socket.resetAndDestroy());
    });

    try {
      const startedAt = performance.now();
      await assert.rejects(createModbusUnit(options(portOf(server))).read(), /ECONNRESET/);

      assert.ok(performance.now() - startedAt < BUDGET_MS, 'a reset should not wait out the timeout');
    } finally {
      server.close();
    }
  });

  it('times out when the unit accepts and then says nothing', async () => {
    const server = await listening(() => {
      // Connected, and silent.
    });

    try {
      await assert.rejects(
        createModbusUnit(options(portOf(server))).read(),
        /did not answer within 150 ms/,
      );
    } finally {
      server.close();
    }
  });

  it('propagates a refused connection', async () => {
    const server = await listening(() => undefined);
    const port = portOf(server);
    await new Promise<void>((resolve) => server.close(() => resolve()));

    await assert.rejects(createModbusUnit(options(port)).read(), /ECONNREFUSED/);
  });
});
