import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createModbusUnit } from '../src/actuator/modbus-tcp.ts';
import type { ByteStream, ModbusUnitOptions } from '../src/actuator/modbus-tcp.ts';

// Short enough that the one test which waits for a timeout waits five
// milliseconds. Nothing else here touches the clock.
const OPTIONS: ModbusUnitOptions = {
  host: '192.168.0.65',
  port: 502,
  unitId: 1,
  timeoutMs: 5,
  retries: 0,
  retryPauseMs: 0,
};

interface FakeStream {
  readonly sent: Uint8Array[];
  readonly stream: ByteStream;
}

/**
 * Answers each request with whatever `reply` returns — one entry per chunk, so a
 * frame can be delivered split in half, or not at all. `thenFails` drops the
 * connection once those chunks have been delivered.
 */
function fakeStreams(
  reply: (request: Uint8Array) => readonly Uint8Array[],
  thenFails?: Error,
): FakeStream {
  const sent: Uint8Array[] = [];
  let onChunk: (chunk: Uint8Array) => void = () => undefined;
  let onError: (error: Error) => void = () => undefined;

  const stream: ByteStream = {
    send(bytes) {
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
      // A fresh connection per request, so this fires once per exchange.
    },
  };

  return { sent, stream };
}

function unitOver(fake: FakeStream, options: ModbusUnitOptions = OPTIONS): ReturnType<typeof createModbusUnit> {
  return createModbusUnit(options, async () => fake.stream);
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

    await assert.rejects(unitOver(fake).set(50), /did not answer within 5 ms/);
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
