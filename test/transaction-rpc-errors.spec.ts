import { WativeError } from 'wative-core';
import {
  assertSimulationTransport,
  stopSubmittedTracker,
  submitTransaction,
} from '../src/session/transactions.controller';
import type { Transaction, TransactionTracker } from 'wative-core';
import type { Session } from '../src/session/session.registry';

describe('simulation RPC error normalization', () => {
  it('throws current EVM transport errors', () => {
    const error = new WativeError('RPC_UNREACHABLE', 'relay failed');
    expect(() => assertSimulationTransport({ success: false, raw: error })).toThrow(error);
  });

  it('maps current SVM plain transport errors instead of returning HTTP 200', () => {
    expect(() =>
      assertSimulationTransport({ success: false, raw: new Error('relay rejected') }),
    ).toThrow(expect.objectContaining({ code: 'TEE_RPC_UNREACHABLE' }));
  });

  it('preserves ordinary on-chain simulation failures as a result', () => {
    expect(() =>
      assertSimulationTransport({
        success: false,
        raw: { value: { err: { InstructionError: [0, 'Custom'] } } },
      }),
    ).not.toThrow();
  });

  it('does not inspect successful simulation raw data', () => {
    expect(() => assertSimulationTransport({ success: true, raw: new Error('ignored') })).not.toThrow();
  });
});

describe('submitted transaction tracker cleanup', () => {
  it('blocks new relay calls, aborts polling, and waits for transport drain', async () => {
    let finishDrain!: () => void;
    const release = jest.fn();
    const boundary = {
      abortWorkspace: jest.fn(() => release),
      waitForWorkspaceDrain: jest.fn(
        () => new Promise<void>((resolve) => (finishDrain = resolve)),
      ),
    };
    const tracker = { abort: jest.fn() };
    let settled = false;
    const cleanup = stopSubmittedTracker(
      tracker,
      boundary as never,
      { tenantId: 'acme', workspaceSlug: 'desk-a' },
    ).then(() => {
      settled = true;
    });

    await Promise.resolve();
    expect(boundary.abortWorkspace).toHaveBeenCalledWith('acme', 'desk-a');
    expect(tracker.abort).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(release).not.toHaveBeenCalled();

    finishDrain();
    await cleanup;
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe('uncertain transaction submission recovery', () => {
  const session = {
    tenantId: 'acme',
    workspaceSlug: 'desk-a',
  } as Session;
  const operations = {
    run: async <T>(_session: Session, _kind: 'transaction', operation: () => Promise<T>) =>
      operation(),
  };
  const boundary = () => {
    const release = jest.fn();
    return {
      release,
      value: {
        abortWorkspace: jest.fn(() => release),
        waitForWorkspaceDrain: jest.fn(async () => undefined),
      },
    };
  };

  function tx(vm: 'evm' | 'svm', hash: string | null, signError?: Error) {
    let value!: {
      vm: 'evm' | 'svm';
      hash: string | null;
      sign: jest.Mock;
    };
    const sign = jest.fn(async (): Promise<Transaction> => {
      if (signError) throw signError;
      value.hash = hash;
      return value as unknown as Transaction;
    });
    value = {
      vm,
      hash: null as string | null,
      sign,
    };
    return value as unknown as Transaction & {
      hash: string | null;
      sign: jest.Mock;
    };
  }

  function tracker(
    status: TransactionTracker['status'],
    submitted: () => Promise<string>,
  ): TransactionTracker & { abort: jest.Mock } {
    return {
      status,
      hash: null,
      history: [],
      receipt: null,
      settled: false,
      value: null,
      whenSubmitted: submitted,
      whenMined: jest.fn(),
      whenConfirmed: jest.fn(),
      whenFinalized: jest.fn(),
      confirm: jest.fn(),
      abort: jest.fn(),
      on: jest.fn(),
    } as unknown as TransactionTracker & { abort: jest.Mock };
  }

  it('awaits signing, returns the offline EVM hash, and drains known submission', async () => {
    const signedHash = `0x${'a'.repeat(64)}`;
    const transaction = tx('evm', signedHash);
    const tracked = tracker('pending', async () => `0x${'b'.repeat(64)}`);
    const address = { sendTransaction: jest.fn(() => tracked) };
    const relay = boundary();

    await expect(
      submitTransaction(transaction, address, session, operations, relay.value, 'ethereum'),
    ).resolves.toEqual({ hash: signedHash, status: 'pending', network: 'ethereum' });
    expect(transaction.sign).toHaveBeenCalledTimes(1);
    expect(address.sendTransaction).toHaveBeenCalledWith(transaction);
    expect(tracked.abort).toHaveBeenCalledTimes(1);
    expect(relay.release).toHaveBeenCalledTimes(1);
  });

  it('returns unknown with the signed ID for EVM transport loss and never aborts it', async () => {
    const signedHash = `0x${'c'.repeat(64)}`;
    const tracked = tracker('timeout', async () => {
      throw new WativeError('RPC_UNREACHABLE', 'lost reply');
    });
    const relay = boundary();

    await expect(
      submitTransaction(
        tx('evm', signedHash),
        { sendTransaction: jest.fn(() => tracked) },
        session,
        operations,
        relay.value,
        'ethereum',
      ),
    ).resolves.toEqual({ hash: signedHash, status: 'unknown', network: 'ethereum' });
    expect(tracked.abort).not.toHaveBeenCalled();
    expect(relay.value.abortWorkspace).not.toHaveBeenCalled();
  });

  it('uses the signed SVM lookup ID when an unusable acknowledgement resolves', async () => {
    const signedHash = '1'.repeat(64);
    const tracked = tracker('timeout', async () => 'attacker-selected-signature');

    await expect(
      submitTransaction(
        tx('svm', signedHash),
        { sendTransaction: jest.fn(() => tracked) },
        session,
        operations,
        boundary().value,
        'solana',
      ),
    ).resolves.toEqual({ hash: signedHash, status: 'unknown', network: 'solana' });
    expect(tracked.abort).not.toHaveBeenCalled();
  });

  it('preserves explicit refusal as an error that is safe to rebuild', async () => {
    const refusal = new WativeError('TX_SUBMIT_FAILED', 'endpoint refused');
    const tracked = tracker('failed', async () => {
      throw refusal;
    });

    await expect(
      submitTransaction(
        tx('evm', `0x${'d'.repeat(64)}`),
        { sendTransaction: jest.fn(() => tracked) },
        session,
        operations,
        boundary().value,
        'ethereum',
      ),
    ).rejects.toBe(refusal);
    expect(tracked.abort).not.toHaveBeenCalled();
  });

  it('preserves the signed ID if send throws after submission begins', async () => {
    const signedHash = `0x${'e'.repeat(64)}`;
    await expect(
      submitTransaction(
        tx('evm', signedHash),
        { sendTransaction: jest.fn(() => { throw new Error('send start probe'); }) },
        session,
        operations,
        boundary().value,
        'ethereum',
      ),
    ).resolves.toEqual({ hash: signedHash, status: 'unknown', network: 'ethereum' });
  });

  it('does not claim submission when signing fails or yields an invalid ID', async () => {
    const signError = new WativeError('TX_SIGN_FAILED', 'sign probe');
    const sendTransaction = jest.fn();
    await expect(
      submitTransaction(
        tx('evm', null, signError),
        { sendTransaction },
        session,
        operations,
        boundary().value,
        'ethereum',
      ),
    ).rejects.toBe(signError);
    await expect(
      submitTransaction(
        tx('svm', 'not-a-signature'),
        { sendTransaction },
        session,
        operations,
        boundary().value,
        'solana',
      ),
    ).rejects.toMatchObject({ code: 'TX_SIGN_FAILED' });
    expect(sendTransaction).not.toHaveBeenCalled();
  });

  it('keeps a known pending result if the outer deadline wins after safe cleanup', async () => {
    const signedHash = `0x${'f'.repeat(64)}`;
    const tracked = tracker('pending', async () => signedHash);
    const deadlineOperations = {
      run: async <T>(_session: Session, _kind: 'transaction', operation: () => Promise<T>) => {
        await operation();
        throw new WativeError('TX_TIMEOUT', 'outer timer won');
      },
    };

    await expect(
      submitTransaction(
        tx('evm', signedHash),
        { sendTransaction: jest.fn(() => tracked) },
        session,
        deadlineOperations,
        boundary().value,
        'ethereum',
      ),
    ).resolves.toEqual({ hash: signedHash, status: 'pending', network: 'ethereum' });
  });

  it('never suppresses a known hash when cleanup fails and retires the session', async () => {
    const signedHash = `0x${'1'.repeat(64)}`;
    const tracked = tracker('pending', async () => signedHash);
    tracked.abort.mockImplementation(() => {
      throw new Error('cleanup abort failed');
    });
    const cleanupSession = {
      tenantId: 'acme',
      workspaceSlug: 'desk-a',
      unusable: false,
    } as Session;
    const relay = boundary();

    await expect(
      submitTransaction(
        tx('evm', signedHash),
        { sendTransaction: jest.fn(() => tracked) },
        cleanupSession,
        operations,
        relay.value,
        'ethereum',
      ),
    ).resolves.toEqual({ hash: signedHash, status: 'pending', network: 'ethereum' });
    expect(relay.value.waitForWorkspaceDrain).toHaveBeenCalledTimes(1);
    expect(relay.release).toHaveBeenCalledTimes(1);
    expect(cleanupSession.unusable).toBe(true);
  });
});
