import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createModbusUnit } from '../src/actuator/modbus-tcp.ts';
import type { ByteStream, ModbusUnitOptions, OpenStream } from '../src/actuator/modbus-tcp.ts';

// Short enough that the one test which waits for a timeout waits five
// milliseconds. Nothing else here touches the clock. The host is deliberately
// not the real unit's address — nothing here dials anything, and a fixture that
// names a live device invites somebody to find out.
const OPTIONS: ModbusUnitOptions = {
  host: 'unit.invalid',
  port: 502,
  unitId: 1,
  timeoutMs: 5,
  retries: 0,
  retryPauseMs: 0,
};

interface FakeTransport {
  readonly sent: Uint8Array[];
  /** Counted so a lost `close()` cannot pass unnoticed — a fake that swallows it
   * would let a socket leak through every test in this file. */
  readonly counts: { opened: number; closed: number };
  readonly open: OpenStream;
}

/**
 * Mints a fresh stream per connection, because the client opens one per request
 * and reusing a closed socket is exactly the mistake a shared fake would hide.
 * Each answers with whatever `reply` returns — one entry per chunk, so a frame
 * can arrive split in half, or not at all. `thenFails` drops the connection once
 * those chunks have been delivered.
 */
function fakeStreams(
  reply: (request: Uint8Array) => readonly Uint8Array[],
  thenFails?: Error,
): FakeTransport {
  const sent: Uint8Array[] = [];
  const counts = { opened: 0, closed: 0 };

  const open: OpenStream = async () => {
    counts.opened += 1;
    let onChunk: (chunk: Uint8Array) => void = () => undefined;
    let onError: (error: Error) => void = () => undefined;
    let closed = false;

    const stream: ByteStream = {
      send(bytes) {
        if (closed) throw new Error('wrote to a stream that was already closed');
        sent.push(bytes);
        const chunks = reply(bytes);
        // Asynchronously, because a socket never answers inside write().
        queueMicrotask(() => {
          for (const chunk of chunks) onChunk(chunk);
          if (thenFails !== undefined) onError(thenFails);
        });
      },
      listen(chunkHandler, errorHandler) {
        onChunk = chunkHandler;
        onError = errorHandler;
      },
      close() {
        closed = true;
        counts.closed += 1;
      },
    };

    return stream;
  };

  return { sent, counts, open };
}

function unitOver(
  fake: FakeTransport,
  options: ModbusUnitOptions = OPTIONS,
): ReturnType<typeof createModbusUnit> {
  return createModbusUnit(options, fake.open);
}

function frame(...bytes: number[]): Uint8Array {
  return new Uint8Array(bytes);
}

/** An FC6 response echoes the request exactly. */
function echo(request: Uint8Array): readonly Uint8Array[] {
  return [request];
}

describe('writing a level', () => {
  it('sends the exact frame the unit expects', async () => {
    const fake = fakeStreams(echo);

    await unitOver(fake).set(50);

    assert.deepEqual(
      Array.from(fake.sent[0] ?? []),
      [
        0x00, 0x01, // transaction id
        0x00, 0x00, // protocol id, always zero over TCP
        0x00, 0x06, // length of what follows
        0x01, // unit id
        0x06, // write single register
        0x52, 0x09, // register 21001 — not 21002; the wire counts from zero
        0x01, 0xf4, // 500, which is 50% times ten
      ],
    );
  });

  it('encodes the level as percent times ten', async () => {
    const fake = fakeStreams(echo);
    const unit = unitOver(fake);

    await unit.set(20);
    await unit.set(80);

    assert.deepEqual(Array.from((fake.sent[0] ?? []).slice(10)), [0x00, 0xc8]); // 200
    assert.deepEqual(Array.from((fake.sent[1] ?? []).slice(10)), [0x03, 0x20]); // 800
  });

  it('gives every request a new transaction id', async () => {
    // Otherwise a late reply to the previous request can be accepted as the
    // answer to this one.
    const fake = fakeStreams(echo);
    const unit = unitOver(fake);

    await unit.set(30);
    await unit.set(40);

    assert.deepEqual(Array.from((fake.sent[0] ?? []).slice(0, 2)), [0x00, 0x01]);
    assert.deepEqual(Array.from((fake.sent[1] ?? []).slice(0, 2)), [0x00, 0x02]);
  });

  it('refuses a level above the ceiling even with the types stripped', async () => {
    const fake = fakeStreams(echo);
    const bypassingTheTypes: { set(level: number): Promise<void> } = unitOver(fake);

    await assert.rejects(bypassingTheTypes.set(100), /not a commandable level/);
    assert.deepEqual(fake.sent, []);
  });

  it('does not report success when the unit echoes something else', async () => {
    // Believing a level the unit never took is worse than an error: the loop
    // would carry on deciding from a number that is not real.
    const fake = fakeStreams(() => [frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x52, 0x09, 0x00, 0xc8)]);

    await assert.rejects(unitOver(fake).set(50), /echoed register 21001 = 200, not 21001 = 500/);
  });
});

describe('reading the level back', () => {
  it('asks for one holding register at 21001', async () => {
    const fake = fakeStreams(() => [
      frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x03, 0x02, 0x01, 0xf4),
    ]);

    await unitOver(fake).read();

    assert.deepEqual(
      Array.from(fake.sent[0] ?? []),
      [0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x01, 0x03, 0x52, 0x09, 0x00, 0x01],
    );
  });

  it('decodes the register back into a level', async () => {
    const fake = fakeStreams(() => [
      frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x03, 0x02, 0x01, 0xf4),
    ]);

    assert.equal(await unitOver(fake).read(), 50);
  });

  it('reads back a level the wall panel set above our ceiling', async () => {
    // 1000 is 100%, which we may never command and must always be able to see.
    const fake = fakeStreams(() => [
      frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x03, 0x02, 0x03, 0xe8),
    ]);

    assert.equal(await unitOver(fake).read(), 100);
  });

  it('rejects a register value that is not a level at all', async () => {
    const fake = fakeStreams(() => [
      frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x03, 0x02, 0x02, 0x2b), // 555 -> 55.5%
    ]);

    await assert.rejects(unitOver(fake).read(), /555, which is not a level/);
  });
});

describe('connections', () => {
  it('closes every connection it opens, on success and on failure', async () => {
    // The leak this guards is invisible to the loopback tests too, because the
    // process exits before anything accumulates. Without counting here, deleting
    // the `finally { stream.close() }` passes the whole suite.
    const succeeding = fakeStreams(echo);
    await unitOver(succeeding).set(50);
    assert.deepEqual(succeeding.counts, { opened: 1, closed: 1 });

    const failing = fakeStreams(() => []);
    await assert.rejects(unitOver(failing, { ...OPTIONS, retries: 2 }).set(50));
    assert.deepEqual(failing.counts, { opened: 3, closed: 3 });
  });

  it('spends its timeout once per attempt, not once per phase', async () => {
    // A slow connect followed by silence still has to fit inside one budget.
    // Giving connecting a full timeout and then waiting another one makes a
    // "five second" attempt take ten, and enough of those overrun the
    // thirty-second cycle the whole operation is supposed to sit inside.
    const slowToOpen: OpenStream = async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return { send: () => undefined, listen: () => undefined, close: () => undefined };
    };

    const unit = createModbusUnit({ ...OPTIONS, timeoutMs: 300, retries: 0 }, slowToOpen);

    const startedAt = performance.now();
    await assert.rejects(unit.read());
    const elapsed = performance.now() - startedAt;

    assert.ok(elapsed < 400, `one attempt took ${Math.round(elapsed)} ms of a 300 ms budget`);
  });

  it('opens a new connection for every attempt', async () => {
    // One request per connection, so a retry cannot reuse the socket that just
    // failed. The fake refuses a write to a closed stream, which is what would
    // catch that.
    const fake = fakeStreams(() => []);

    await assert.rejects(unitOver(fake, { ...OPTIONS, retries: 3 }).read());

    assert.equal(fake.counts.opened, 4);
  });
});

describe('the wire', () => {
  it('reassembles a frame split across chunks', async () => {
    // TCP is free to break a twelve-byte frame anywhere, and the MBAP length
    // field is the only thing that says where the frame ends.
    const fake = fakeStreams((request) => [request.slice(0, 5), request.slice(5)]);

    await unitOver(fake).set(60);
  });

  it('does not accept an answer to a different transaction', async () => {
    // A stale reply must not be mistaken for ours, however well-formed it is.
    const fake = fakeStreams(() => [
      frame(0x00, 0x09, 0x00, 0x00, 0x00, 0x06, 0x01, 0x06, 0x52, 0x09, 0x01, 0xf4),
    ]);

    await assert.rejects(unitOver(fake).set(50), /answer to transaction 9, but we asked 1/);
  });

  it('does not accept an answer to a different function code', async () => {
    // A perfectly well-formed FC3 answer to an FC6 request means something else
    // is talking on this connection. Reading its first four bytes as a register
    // echo would turn someone else's data into our confirmation.
    const fake = fakeStreams(() => [
      frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x05, 0x01, 0x03, 0x02, 0x01, 0xf4),
    ]);

    await assert.rejects(unitOver(fake).set(50), /answered function 3, but we asked 6/);
  });

  it('gives up when the socket dies mid-frame rather than waiting out the timeout', async () => {
    // Half a frame arrives and the connection drops — a flaky wifi bridge, not a
    // slow unit. Sitting out the full five seconds for a socket that is already
    // gone delays every retry queued behind it.
    const fake = fakeStreams((request) => [request.slice(0, 5)], new Error('read ECONNRESET'));

    await assert.rejects(unitOver(fake).set(50), /ECONNRESET/);
  });

  it('does not accept an answer carrying a foreign protocol id', async () => {
    // Zero over TCP, always. Anything else means this is not a Modbus TCP frame,
    // and it was the one header field with no check on it.
    const fake = fakeStreams(() => [
      frame(0x00, 0x01, 0xbe, 0xef, 0x00, 0x06, 0x01, 0x06, 0x52, 0x09, 0x01, 0xf4),
    ]);

    await assert.rejects(unitOver(fake).set(50), /protocol id 48879, but Modbus TCP is always 0/);
  });

  it('does not accept an answer from a different unit', async () => {
    const fake = fakeStreams(() => [
      frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x02, 0x06, 0x52, 0x09, 0x01, 0xf4),
    ]);

    await assert.rejects(unitOver(fake).set(50), /answer from unit 2, but we asked unit 1/);
  });

  it('rejects a frame too short to hold an answer', async () => {
    const fake = fakeStreams(() => [frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x01)]);

    await assert.rejects(unitOver(fake).set(50), /too short to be a frame/);
  });

  it('rejects a read whose body is not one register', async () => {
    // Length 2 leaves a body with no byte count at all, which used to render as
    // "the unit sent undefined bytes" in a message an operator reads at 3am.
    const fake = fakeStreams(() => [frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x02, 0x01, 0x03)]);

    await assert.rejects(unitOver(fake).read(), /expected one register back, the unit sent a 0-byte body/);
  });

  it('ignores whatever follows a complete frame', async () => {
    // The MBAP length says where the answer ends. Anything after it on a
    // one-request connection is not ours to interpret.
    const fake = fakeStreams((request) => [
      new Uint8Array([...request, 0xde, 0xad, 0xbe, 0xef]),
    ]);

    await unitOver(fake).set(50);
  });

  it('surfaces a Modbus exception instead of swallowing it', async () => {
    // The original C# spike caught these into an empty block, which is how a
    // refused write became a silent no-op.
    const fake = fakeStreams(() => [frame(0x00, 0x01, 0x00, 0x00, 0x00, 0x03, 0x01, 0x86, 0x02)]);

    await assert.rejects(unitOver(fake).set(50), /refused the request with Modbus exception 2/);
  });

  it('does not retry a request the unit refused', async () => {
    // The unit answering is a definitive answer. Asking three more times gets
    // the same refusal and delays the loop for no reason.
    let asked = 0;
    const fake = fakeStreams(() => {
      asked += 1;
      return [frame(0x00, asked, 0x00, 0x00, 0x00, 0x03, 0x01, 0x86, 0x02)];
    });

    await assert.rejects(unitOver(fake, { ...OPTIONS, retries: 3 }).set(50), /Modbus exception/);
    assert.equal(asked, 1);
  });

  it('errors rather than hanging when the unit says nothing', async () => {
    const fake = fakeStreams(() => []);

    await assert.rejects(unitOver(fake).set(50), /did not answer within \d+ ms/);
  });

  it('retries a request that timed out, and succeeds on a later attempt', async () => {
    let asked = 0;
    const fake = fakeStreams((request) => {
      asked += 1;
      return asked < 3 ? [] : [request];
    });

    await unitOver(fake, { ...OPTIONS, retries: 3 }).set(50);

    assert.equal(asked, 3);
  });

  it('propagates a refused connection cleanly', async () => {
    const unit = createModbusUnit(OPTIONS, async () => {
      throw new Error('connect ECONNREFUSED 192.168.0.65:502');
    });

    await assert.rejects(unit.read(), /ECONNREFUSED/);
  });
});
