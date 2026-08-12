import request from 'supertest';
import type { Address, Transaction, TransactionTracker } from 'wative-core';
import { WativeError } from 'wative-core';
import { JwtService } from '../../src/auth/jwt.service';
import { OperatorConfigService } from '../../src/config/operator-config.service';
import { SessionRegistry } from '../../src/session/session.registry';
import { authHeaders, boot, type Harness } from '../harness/boot';

const PASSWORD = 'Transaction-Outcome-Passw0rd!';

describe('H-08 transaction outcome flow', () => {
  let harness: Harness;
  let token: string;
  let evm: Address;
  let svm: Address;
  const http = () => request(harness.app.getHttpServer());
  const bearer = () => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    harness = await boot();
    await http()
      .post('/v1/workspaces')
      .set(authHeaders())
      .send({ slug: 'outcome-desk', password: PASSWORD })
      .expect(201);
    token = (
      await http()
        .post('/v1/auth/token')
        .set(authHeaders())
        .send({ workspace: 'outcome-desk', password: PASSWORD })
        .expect(201)
    ).body.token;
    await http()
      .post('/v1/accounts')
      .set(bearer())
      .send({ displayName: 'Outcome Desk', kind: 'HD' })
      .expect(201);

    const claims = harness.app.get(JwtService).verify(token);
    const tenant = harness.app.get(OperatorConfigService).byId(claims.tid)!;
    const session = harness.app.get(SessionRegistry).get(
      claims.sid,
      claims.jti,
      claims.tid,
      claims.ws,
      claims.scp,
      tenant.ttl.workspaceIdleSec,
    )!.session;
    const addresses = session.handle.accounts[0].wallets[0].addresses;
    evm = addresses.find((address) => address.vm === 'evm')!;
    svm = addresses.find((address) => address.vm === 'svm')!;
  });

  afterAll(async () => {
    await harness?.close();
  });

  it.each([
    {
      vm: 'evm' as const,
      address: () => evm,
      hash: `0x${'a'.repeat(64)}`,
      body: () => ({
        address: String(evm.publicKey),
        to: '0x000000000000000000000000000000000000dEaD',
        value: '1',
      }),
      network: 'ethereum',
    },
    {
      vm: 'svm' as const,
      address: () => svm,
      hash: '1'.repeat(64),
      body: () => ({
        address: String(svm.publicKey),
        recipient: '11111111111111111111111111111111',
        amount: '1',
        recentBlockhash: '11111111111111111111111111111111',
      }),
      network: 'solana',
    },
  ])('returns the signed $vm lookup ID for an uncertain outcome', async (entry) => {
    const transaction = fakeTransaction(entry.vm, entry.hash);
    const tracked = fakeTracker('timeout', async () => {
      throw new WativeError('TX_SUBMIT_FAILED', 'unusable reply');
    });
    const address = entry.address();
    const build = jest.spyOn(address, 'buildTransaction').mockReturnValue(transaction as never);
    const send = jest.spyOn(address, 'sendTransaction').mockReturnValue(tracked);
    try {
      const response = await http()
        .post('/v1/transactions/send')
        .set(bearer())
        .send(entry.body())
        .expect(202);
      expect(response.body).toEqual({
        hash: entry.hash,
        status: 'unknown',
        network: entry.network,
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(tracked.abort).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
      send.mockRestore();
    }
  });

  it('keeps an explicit endpoint refusal as a mapped error', async () => {
    const transaction = fakeTransaction('evm', `0x${'b'.repeat(64)}`);
    const tracked = fakeTracker('failed', async () => {
      throw new WativeError('TX_SUBMIT_FAILED', 'endpoint refused');
    });
    const build = jest.spyOn(evm, 'buildTransaction').mockReturnValue(transaction as never);
    const send = jest.spyOn(evm, 'sendTransaction').mockReturnValue(tracked);
    try {
      const response = await http()
        .post('/v1/transactions/send')
        .set(bearer())
        .send({
          address: String(evm.publicKey),
          to: '0x000000000000000000000000000000000000dEaD',
          value: '1',
        })
        .expect(502);
      expect(response.body.error).toMatchObject({ code: 'tx_submit_failed' });
      expect(JSON.stringify(response.body)).not.toContain(transaction.hash as string);
      expect(tracked.abort).not.toHaveBeenCalled();
    } finally {
      build.mockRestore();
      send.mockRestore();
    }
  });
});

function fakeTransaction(vm: 'evm' | 'svm', hash: string): Transaction & { hash: string | null } {
  const transaction = {
    vm,
    hash: null as string | null,
    async sign(): Promise<Transaction> {
      transaction.hash = hash;
      return transaction as unknown as Transaction;
    },
  };
  return transaction as unknown as Transaction & { hash: string | null };
}

function fakeTracker(
  status: TransactionTracker['status'],
  whenSubmitted: () => Promise<string>,
): TransactionTracker & { abort: jest.Mock } {
  return {
    status,
    hash: null,
    history: [],
    receipt: null,
    settled: false,
    value: null,
    whenSubmitted,
    whenMined: jest.fn(),
    whenConfirmed: jest.fn(),
    whenFinalized: jest.fn(),
    confirm: jest.fn(),
    abort: jest.fn(),
    on: jest.fn(),
  } as unknown as TransactionTracker & { abort: jest.Mock };
}
