import { EvmTransaction, SvmTransaction, type Transaction } from 'wative-core';
import { projectBuiltTransaction } from '../src/session/transaction-projector';

const FROM = '0x0000000000000000000000000000000000000001';
const TO = '0x0000000000000000000000000000000000000002';
const SOL = '11111111111111111111111111111111';

function fake(vm: 'evm' | 'svm', raw: unknown): Transaction {
  return {
    vm,
    status: 'draft',
    sign: jest.fn(),
    send: jest.fn(),
    simulate: jest.fn(),
    toRawTx: () => raw,
  } as unknown as Transaction;
}

describe('built transaction projection', () => {
  it('projects every supported EVM field and omits credentials and unknown cycles', async () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const transaction = fake('evm', {
      from: FROM,
      to: TO,
      value: 1n,
      data: '0x1234',
      type: 2,
      chainId: 1,
      nonce: 7,
      gasPrice: 2n,
      maxFeePerGas: 3n,
      maxPriorityFeePerGas: 4n,
      gasLimit: 21_000n,
      accessList: [{ address: TO, storageKeys: [`0x${'0'.repeat(64)}`] }],
      rpcUrl: 'https://user:secret@rpc.invalid/API_KEY',
      provider: { url: 'http://127.0.0.1:1234/rpc/CAPABILITY' },
      unknown: cycle,
    });

    await expect(projectBuiltTransaction(transaction)).resolves.toEqual({
      from: FROM,
      to: TO,
      value: '1',
      data: '0x1234',
      type: 2,
      chainId: 1,
      nonce: 7,
      gasPrice: '2',
      maxFeePerGas: '3',
      maxPriorityFeePerGas: '4',
      gasLimit: '21000',
      accessList: [{ address: TO, storageKeys: [`0x${'0'.repeat(64)}`] }],
    });
  });

  it('does not invoke unknown getters or toJSON methods', async () => {
    const raw = {
      from: FROM,
      to: TO,
      value: 1n,
      data: '0x',
      type: 2,
      chainId: 1,
    } as Record<string, unknown>;
    Object.defineProperty(raw, 'rpcUrl', {
      enumerable: true,
      get: () => {
        throw new Error('unknown getter invoked');
      },
    });
    raw.toJSON = () => {
      throw new Error('toJSON invoked');
    };
    await expect(projectBuiltTransaction(fake('evm', raw))).resolves.toMatchObject({ value: '1' });
  });

  it('rejects inherited or accessor-backed allowlisted fields', async () => {
    const inherited = Object.create(baseEvm()) as Record<string, unknown>;
    await expect(projectBuiltTransaction(fake('evm', inherited))).rejects.toMatchObject({
      code: 'TEE_UNSUPPORTED_FOR_KIND',
    });
    const accessor = baseEvm();
    Object.defineProperty(accessor, 'from', {
      enumerable: true,
      get: () => 'http://127.0.0.1:1/rpc/CAPABILITY',
    });
    await expect(projectBuiltTransaction(fake('evm', accessor))).rejects.toMatchObject({
      code: 'TEE_UNSUPPORTED_FOR_KIND',
    });
  });

  it('rejects unsupported VM values instead of treating them as SVM', async () => {
    await expect(projectBuiltTransaction(fake('sui' as 'evm', baseEvm()))).rejects.toMatchObject({
      code: 'TEE_UNSUPPORTED_FOR_KIND',
    });
  });

  it('rejects exotic arrays instead of invoking their methods or species', async () => {
    const accessList = [] as unknown[];
    Object.defineProperty(accessList, 'map', {
      value: () => ({ rpcUrl: 'CAPABILITY' }),
    });
    await expect(projectBuiltTransaction(fake('evm', {
      ...baseEvm(),
      accessList,
    }))).rejects.toMatchObject({ code: 'TEE_UNSUPPORTED_FOR_KIND' });

    class EvilArray extends Array<unknown> {
      static get [Symbol.species](): ArrayConstructor {
        throw new Error('species invoked');
      }
    }
    const instructions = new EvilArray();
    await expect(projectBuiltTransaction(fake('svm', {
      recentBlockhash: SOL,
      feePayer: SOL,
      nonceInfo: null,
      signatures: [],
      instructions,
    }))).rejects.toMatchObject({ code: 'TEE_UNSUPPORTED_FOR_KIND' });
  });

  it('does not mutate a frozen transaction or its rpcUrl', async () => {
    const transaction = new EvmTransaction({
      from: FROM,
      to: TO,
      value: 1n,
      data: '0x',
      type: 2,
      chainId: 1,
      rpcUrl: 'http://127.0.0.1:1234/rpc/CAPABILITY',
    } as never);
    Object.freeze(transaction);
    await expect(projectBuiltTransaction(transaction)).resolves.toMatchObject({ value: '1' });
    expect(transaction.rpcUrl).toContain('CAPABILITY');
  });

  it('projects the exact real wative-core 2.4.4 SVM public shape', async () => {
    const transaction = new SvmTransaction({
      from: SOL,
      recipient: SOL,
      amount: 1n,
      recentBlockhash: SOL,
      rpcUrl: 'http://127.0.0.1:1234/rpc/CAPABILITY',
    } as never);
    const projected = await projectBuiltTransaction(transaction);
    expect(projected).toEqual({
      recentBlockhash: SOL,
      feePayer: SOL,
      nonceInfo: null,
      instructions: [
        {
          keys: [
            { pubkey: SOL, isSigner: true, isWritable: true },
            { pubkey: SOL, isSigner: false, isWritable: true },
          ],
          programId: SOL,
          data: [2, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0],
        },
      ],
      signers: [SOL],
    });
    expect(JSON.stringify(projected)).not.toContain('CAPABILITY');
  });

  it('ignores nested SVM extras while projecting known fields', async () => {
    const projected = await projectBuiltTransaction(fake('svm', {
      recentBlockhash: SOL,
      feePayer: SOL,
      nonceInfo: null,
      signatures: [{ publicKey: SOL, privateKey: 'SECRET' }],
      instructions: [{
        programId: SOL,
        credentials: 'SECRET',
        keys: [{ pubkey: SOL, isSigner: true, isWritable: false, secret: 'SECRET' }],
        data: Uint8Array.from([1, 2]),
      }],
      rpcUrl: 'SECRET',
    }));
    expect(projected).toEqual({
      recentBlockhash: SOL,
      feePayer: SOL,
      nonceInfo: null,
      instructions: [{
        programId: SOL,
        keys: [{ pubkey: SOL, isSigner: true, isWritable: false }],
        data: [1, 2],
      }],
      signers: [SOL],
    });
    expect(JSON.stringify(projected)).not.toContain('SECRET');
  });

  it('derives PublicKey output locally and rejects credential-like strings', async () => {
    const forged = Object.create({
      constructor: { name: 'PublicKey' },
      toBytes: () => new Uint8Array(32),
      toBase58: () => 'https://rpc.invalid/SECRET',
    }) as object;
    const projected = await projectBuiltTransaction(fake('svm', {
      recentBlockhash: SOL,
      feePayer: forged,
      nonceInfo: null,
      signatures: [{ publicKey: forged }],
      instructions: [{ programId: forged, keys: [], data: new Uint8Array() }],
    }));
    expect(JSON.stringify(projected)).not.toContain('SECRET');
    expect(projected).toMatchObject({ feePayer: SOL, signers: [SOL] });

    await expect(projectBuiltTransaction(fake('svm', {
      recentBlockhash: 'https://rpc.invalid/SECRET',
      feePayer: 'https://rpc.invalid/SECRET',
      nonceInfo: null,
      signatures: [],
      instructions: [],
    }))).rejects.toMatchObject({ code: 'TEE_UNSUPPORTED_FOR_KIND' });
  });

  it.each([
    { ...baseEvm(), value: -1n },
    { ...baseEvm(), value: `1${'0'.repeat(78)}` },
    { ...baseEvm(), value: 1n << 256n },
    { ...baseEvm(), chainId: Number.MAX_SAFE_INTEGER + 1 },
    { ...baseEvm(), type: 3 },
    { ...baseEvm(), data: `0x${'0'.repeat(100 * 1024)}` },
    { ...baseEvm(), accessList: Array.from({ length: 257 }, () => ({ address: TO, storageKeys: [] })) },
  ])('rejects malformed or oversized EVM raw data', async (raw) => {
    await expect(projectBuiltTransaction(fake('evm', raw))).rejects.toMatchObject({
      code: 'TEE_UNSUPPORTED_FOR_KIND',
    });
  });

  it('rejects SVM instruction data beyond the transaction ceiling', async () => {
    await expect(projectBuiltTransaction(fake('svm', {
      recentBlockhash: SOL,
      feePayer: SOL,
      nonceInfo: null,
      signatures: [],
      instructions: [{ programId: SOL, keys: [], data: new Uint8Array(1_233) }],
    }))).rejects.toMatchObject({ code: 'TEE_UNSUPPORTED_FOR_KIND' });
  });
});

function baseEvm(): Record<string, unknown> {
  return { from: FROM, to: TO, value: 1n, data: '0x', type: 2, chainId: 1 };
}
