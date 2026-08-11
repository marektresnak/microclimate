import { connect } from 'node:net';

import { assertCommandedLevel, toLevel } from '../domain/level.ts';
import type { CommandedLevel } from '../domain/level.ts';
import type { VentilationUnit } from './unit.ts';

/**
 * Modbus TCP against the 2VV Daphne, hand-rolled.
 *
 * We need two function codes against one register. A general Modbus library is
 * several thousand lines of protocol we do not use; this is a hundred that can
 * be read in one sitting and tested byte by byte against a fake stream.
 *
 * Everything below was recovered from earlier C# spikes proven against the real
 * unit: address, unit id, register number, value encoding, timeout, retries.
 */

// **21001, not the 21002 the documentation gives.** The usual Modbus convention
// clash: documentation numbers registers from 1, the wire numbers them from 0.
// This is not a bug and must not be "corrected".
const FAN_SPEED_REGISTER = 21_001;

// The unit stores percent times ten: 400 means 40%.
const PERCENT_SCALE = 10;

const READ_HOLDING_REGISTERS = 0x03;
const WRITE_SINGLE_REGISTER = 0x06;
const EXCEPTION_FLAG = 0x80;
const MBAP_HEADER_BYTES = 7;
const MBAP_LENGTH_OFFSET = 4;
// One unit id plus the largest PDU Modbus allows.
const MAX_MBAP_LENGTH = 254;

/**
 * A raw byte stream, so the protocol can be tested without a socket. Chunk
 * boundaries are deliberately the caller's problem: TCP is free to split a
 * twelve-byte frame in half, and reassembling it is the part worth testing.
 */
export interface ByteStream {
  send(bytes: Uint8Array): void;
  listen(onChunk: (chunk: Uint8Array) => void, onError: (error: Error) => void): void;
  close(): void;
}

export type OpenStream = (host: string, port: number, timeoutMs: number) => Promise<ByteStream>;

export interface ModbusUnitOptions {
  readonly host: string;
  readonly port: number;
  readonly unitId: number;
  /** Covers connecting as well as waiting for the answer — see `openTcpStream`. */
  readonly timeoutMs: number;
  readonly retries: number;
  /** Between attempts. Reconnecting the instant a device refused you is the
   * least likely attempt to succeed, and four of those inside a millisecond is
   * one attempt wearing a disguise. */
  readonly retryPauseMs: number;
}

export function createModbusUnit(
  options: ModbusUnitOptions,
  openStream: OpenStream = openTcpStream,
): VentilationUnit {
  // The unit id is narrowed because its bad values fail *silently*:
  // Number("banana") is NaN, a Uint8Array coerces NaN to 0, and 0 is the Modbus
  // broadcast address — the unit would act on a write and never reply, so a
  // command that landed would be reported as having failed.
  //
  // The host and port get no such guard, deliberately. A nonsense port fails
  // loudly on every attempt with the operating system's own message, which the
  // loop logs and recovers from; there is nothing silent to protect against, and
  // a guard per field would be ceremony rather than defence.
  if (!Number.isInteger(options.unitId) || options.unitId < 1 || options.unitId > 247) {
    throw new Error(`unit id ${options.unitId} is not a Modbus slave address (1-247)`);
  }

  // Monotonic across the process, so a reply to an earlier request can never be
  // mistaken for the answer to this one.
  let lastTransactionId = 0;

  const nextTransactionId = (): number => {
    lastTransactionId = (lastTransactionId + 1) % 0x1_0000;
    return lastTransactionId;
  };

  const exchange = async (request: Uint8Array): Promise<Uint8Array> => {
    // A fresh connection per request. At two requests every thirty seconds a
    // persistent socket is state to manage — stale connections, reconnection,
    // half-open detection — bought with nothing.
    //
    // `timeoutMs` is the budget for the whole attempt, not for each half of it.
    // Spending a full timeout on connecting and then another on waiting makes a
    // "five second" attempt take ten, and enough of those overrun the thirty
    // second cycle they are supposed to fit inside.
    const startedAt = performance.now();
    const stream = await openStream(options.host, options.port, options.timeoutMs);

    try {
      const remaining = options.timeoutMs - (performance.now() - startedAt);
      if (remaining <= 0) {
        throw new Error(`connecting to ${options.host} used the whole ${options.timeoutMs} ms`);
      }

      return await sendAndWait(stream, request, remaining);
    } finally {
      stream.close();
    }
  };

  const ask = async (request: Uint8Array, expectedCode: number): Promise<Uint8Array> => {
    let lastFailure: Error | undefined;

    for (let attempt = 0; attempt <= options.retries; attempt += 1) {
      let response: Uint8Array;

      try {
        response = await exchange(request);
      } catch (error) {
        // Network trouble: a refused connection, a timeout, a dropped socket.
        // Worth another go, after a pause.
        lastFailure = error instanceof Error ? error : new Error(String(error));
        if (attempt < options.retries) await pause(options.retryPauseMs);
        continue;
      }

      // A frame arrived. Whether or not we like it, asking again gets the same
      // answer — so anything wrong with it here is thrown rather than retried.
      //
      // Note where the line falls: a frame we cannot even delimit, because the
      // declared length is nonsense, fails during reassembly above and *is*
      // retried. That is deliberate. Failing to frame means the connection is
      // not carrying Modbus at all, and a fresh one is worth trying; failing to
      // agree with a frame we did read means the unit has answered and will
      // answer the same way again.
      return readAnswer(response, request, expectedCode, options.unitId);
    }

    throw lastFailure ?? new Error('the unit was never asked');
  };

  return {
    async read() {
      const request = buildFrame(nextTransactionId(), options.unitId, [
        READ_HOLDING_REGISTERS,
        ...toBigEndian(FAN_SPEED_REGISTER),
        ...toBigEndian(1),
      ]);

      const body = await ask(request, READ_HOLDING_REGISTERS);
      if (body.length < 3 || body[0] !== 2) {
        throw new Error(`expected one register back, the unit sent a ${body.length}-byte body`);
      }

      const raw = fromBigEndian(body, 1);
      const level = toLevel(raw / PERCENT_SCALE);
      if (level === undefined) {
        throw new Error(`the unit reported register value ${raw}, which is not a level`);
      }

      return level;
    },

    async set(level: CommandedLevel) {
      // The runtime half of the type, at the one place a level stops being a
      // TypeScript union and becomes two bytes on a wire. Type stripping checks
      // nothing, and the intake grille cannot pass the air above the ceiling.
      const checked = assertCommandedLevel(level);
      const value = checked * PERCENT_SCALE;

      const request = buildFrame(nextTransactionId(), options.unitId, [
        WRITE_SINGLE_REGISTER,
        ...toBigEndian(FAN_SPEED_REGISTER),
        ...toBigEndian(value),
      ]);

      // FC6 echoes back the register and the value it wrote. A disagreeing echo
      // means something else is on the wire, and reporting success would leave
      // the loop believing a level the unit never took.
      const body = await ask(request, WRITE_SINGLE_REGISTER);
      if (body.length < 4) {
        throw new Error(`expected the register and value echoed back, the unit sent a ${body.length}-byte body`);
      }

      const echoedRegister = fromBigEndian(body, 0);
      const echoedValue = fromBigEndian(body, 2);

      if (echoedRegister !== FAN_SPEED_REGISTER || echoedValue !== value) {
        throw new Error(
          `the unit echoed register ${echoedRegister} = ${echoedValue}, not ${FAN_SPEED_REGISTER} = ${value}`,
        );
      }
    },
  };
}

// MBAP header then PDU: transaction id, protocol id (always zero over TCP), the
// length of everything after this field, unit id.
function buildFrame(transactionId: number, unitId: number, pdu: readonly number[]): Uint8Array {
  const frame = new Uint8Array(MBAP_HEADER_BYTES + pdu.length);

  frame.set(toBigEndian(transactionId), 0);
  frame.set(toBigEndian(0), 2);
  frame.set(toBigEndian(pdu.length + 1), MBAP_LENGTH_OFFSET);
  frame[6] = unitId;
  frame.set(pdu, MBAP_HEADER_BYTES);

  return frame;
}

/** The PDU body after the function code, having checked everything before it. */
function readAnswer(
  response: Uint8Array,
  request: Uint8Array,
  expectedCode: number,
  unitId: number,
): Uint8Array {
  if (response.length < MBAP_HEADER_BYTES + 1) {
    throw new Error(`the unit sent ${response.length} bytes, too short to be a frame`);
  }

  const asked = fromBigEndian(request, 0);
  const answered = fromBigEndian(response, 0);
  if (answered !== asked) {
    throw new Error(`answer to transaction ${answered}, but we asked ${asked}`);
  }

  // The one header field that carried no check. It is always zero over TCP, so
  // anything else means this is not a Modbus TCP frame at all.
  const protocol = fromBigEndian(response, 2);
  if (protocol !== 0) {
    throw new Error(`answer carries protocol id ${protocol}, but Modbus TCP is always 0`);
  }

  if (response[6] !== unitId) {
    throw new Error(`answer from unit ${String(response[6])}, but we asked unit ${unitId}`);
  }

  const code = response[MBAP_HEADER_BYTES];
  if (code === undefined) throw new Error('the unit sent a frame with no function code');

  // The original C# spike swallowed these in an empty catch, which is how a
  // refused write became a silent no-op.
  if ((code & EXCEPTION_FLAG) !== 0) {
    const reason = response[MBAP_HEADER_BYTES + 1] ?? 0;
    throw new Error(`the unit refused the request with Modbus exception ${reason}`);
  }

  if (code !== expectedCode) {
    throw new Error(`the unit answered function ${code}, but we asked ${expectedCode}`);
  }

  return response.slice(MBAP_HEADER_BYTES + 1);
}

function sendAndWait(
  stream: ByteStream,
  request: Uint8Array,
  timeoutMs: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    let received: Uint8Array = new Uint8Array(0);

    const timer = setTimeout(() => {
      reject(new Error(`the unit did not answer in the ${Math.round(timeoutMs)} ms left after connecting`));
    }, timeoutMs);

    stream.listen(
      (chunk) => {
        received = concat(received, chunk);

        try {
          const frame = completeFrame(received);
          if (frame === undefined) return;

          clearTimeout(timer);
          resolve(frame);
        } catch (error) {
          // A malformed length claim is the peer answering badly, not silence.
          // Escaping this handler would put it on the socket instead.
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );

    stream.send(request);
  });
}

// TCP may deliver a frame in any number of chunks. The MBAP length field says
// how many bytes follow it, and is the only way to know where a frame ends.
//
// It is also the one number on this transport that a peer chooses for us, so it
// is bounded. A frame is at most a unit id and a 253-byte PDU; believing a claim
// of 65535 means waiting out the whole budget for bytes that will never arrive,
// while buffering whatever does — and then retrying the same garbage.
function completeFrame(received: Uint8Array): Uint8Array | undefined {
  if (received.length < MBAP_HEADER_BYTES - 1) return undefined;

  const declared = fromBigEndian(received, MBAP_LENGTH_OFFSET);
  if (declared > MAX_MBAP_LENGTH) {
    throw new Error(`the answer declares ${declared} bytes, more than a Modbus frame can hold`);
  }

  const total = MBAP_LENGTH_OFFSET + 2 + declared;
  return received.length < total ? undefined : received.slice(0, total);
}

function toBigEndian(value: number): readonly number[] {
  return [(value >> 8) & 0xff, value & 0xff];
}

function fromBigEndian(bytes: Uint8Array, offset: number): number {
  const high = bytes[offset];
  const low = bytes[offset + 1];

  if (high === undefined || low === undefined) {
    throw new Error(`the frame ends before offset ${offset + 1}`);
  }

  return (high << 8) | low;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const joined = new Uint8Array(left.length + right.length);
  joined.set(left, 0);
  joined.set(right, left.length);
  return joined;
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function openTcpStream(host: string, port: number, timeoutMs: number): Promise<ByteStream> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });

    // Connecting has to sit inside the budget. Left to the operating system, an
    // address that has stopped answering SYNs blocks for over a minute per
    // attempt, against a thirty-second control cycle.
    //
    // An explicit timer rather than `socket.setTimeout`, which reads zero as "no
    // timeout at all" — so a misconfigured budget would hang here forever rather
    // than failing immediately, which is the failure this exists to prevent.
    const connectTimer = setTimeout(() => {
      socket.destroy(new Error(`no connection to ${host}:${port} within ${timeoutMs} ms`));
    }, timeoutMs);

    // Deliberately left attached after the promise settles. Rejecting a settled
    // promise is a no-op, and it means the socket is never for one instant
    // without an error listener — which is what Node turns into a crash.
    socket.once('error', (error) => {
      clearTimeout(connectTimer);
      reject(error);
    });

    socket.once('connect', () => {
      clearTimeout(connectTimer);

      resolve({
        send: (bytes) => void socket.write(bytes),
        listen: (onChunk, onError) => {
          socket.on('data', onChunk);
          socket.on('error', onError);
          // A unit that accepts the connection and then closes it without
          // answering produces no data and no error, so without this the
          // exchange waits out its whole timeout for a socket already gone.
          // Small embedded stacks shed load exactly this way.
          //
          // This also fires on our own `close()` after a successful exchange,
          // where rejecting a settled promise does nothing.
          socket.on('close', () => onError(new Error('the unit closed the connection')));
        },
        close: () => void socket.destroy(),
      });
    });
  });
}
