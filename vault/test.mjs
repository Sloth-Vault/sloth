// Offline checks. Real chain behaviour is covered by live-check.mjs.
import assert from 'node:assert/strict';
import { Keypair, PublicKey, TransactionMessage } from '@solana/web3.js';
import { createTransferCheckedInstruction, getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import * as s from './sloth.mjs';

const { multisig } = s;
const hash = Keypair.generate().publicKey.toBase58();
const pk = () => Keypair.generate().publicKey;
const compiled = (payer, ixs) => multisig.utils.transactionMessageToMultisigTransactionMessageBytes({
  message: new TransactionMessage({ payerKey: payer, recentBlockhash: hash, instructions: ixs }),
  addressLookupTableAccounts: [], vaultPda: payer,
});
const asTx = (bytes) => ({ message: multisig.types.transactionMessageBeet.deserialize(Buffer.from(bytes))[0] });
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

const vault = pk(), to = pk();

t('sol move decodes to amount and destination', () => {
  const m = s.decodeVaultMove(asTx(compiled(vault, [s.solInstruction(vault, to, 1500000000n)])));
  assert.equal(m.kind, 'sol');
  assert.equal(m.lamports, 1500000000n);
  assert.ok(m.to.equals(to));
});

t('token-2022 move decodes', () => {
  const mint = pk();
  const src = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
  const dst = getAssociatedTokenAddressSync(mint, to, true, TOKEN_2022_PROGRAM_ID);
  const ix = createTransferCheckedInstruction(src, mint, dst, vault, 777n, 6, [], TOKEN_2022_PROGRAM_ID);
  const m = s.decodeVaultMove(asTx(compiled(vault, [ix])));
  assert.equal(m.kind, 'token');
  assert.equal(m.amount, 777n);
  assert.equal(m.decimals, 6);
  assert.ok(m.toAccount.equals(dst));
});

t('two instructions never pass as a plain transfer', () => {
  const ixs = [s.solInstruction(vault, to, 1n), s.solInstruction(vault, pk(), 2n)];
  assert.equal(s.decodeVaultMove(asTx(compiled(vault, ixs))).kind, 'unknown');
});

t('a different program with the same bytes is unknown', () => {
  const ix = s.solInstruction(vault, to, 1n);
  ix.programId = pk();
  assert.equal(s.decodeVaultMove(asTx(compiled(vault, [ix]))).kind, 'unknown');
});

t('config: only an add plus a remove reads as a key change', () => {
  const a = pk(), b = pk();
  const add = { __kind: 'AddMember', newMember: { key: a, permissions: s.fullAccess() } };
  const rm = { __kind: 'RemoveMember', oldMember: b };
  const rotate = s.decodeConfigMove({ actions: [add, rm] });
  assert.equal(rotate.kind, 'rotate');
  assert.ok(rotate.newKey.equals(a));
  assert.equal(s.decodeConfigMove({ actions: [{ __kind: 'SetTimeLock', newTimeLock: 0 }] }).kind, 'unknown');
  assert.equal(s.decodeConfigMove({ actions: [add, rm, { __kind: 'ChangeThreshold', newThreshold: 1 }] }).kind, 'unknown');
});

t('roles', () => {
  assert.equal(s.roleOf({ permissions: s.fullAccess() }), 'full');
  assert.equal(s.roleOf({ permissions: s.voteOnly() }), 'vote');
});

const wallet = pk().toBase58();
const req = (o) => ({ type: 'vault', status: 'Active', stale: false, approved: [], rejected: [], cancelled: [], releaseAt: null, ...o });

t('guardian can vote and cancel but never release', () => {
  const m = { role: 'vote' };
  assert.equal(s.actionsFor(req({}), wallet, m, 0).approve, true);
  const a = s.actionsFor(req({ status: 'Approved', releaseAt: 100 }), wallet, m, 200);
  assert.equal(a.cancel, true);
  assert.equal(a.release, false);
});

t('nothing releases before the wait ends', () => {
  const m = { role: 'full' };
  assert.equal(s.actionsFor(req({ status: 'Approved', releaseAt: 100 }), wallet, m, 99).release, false);
  assert.equal(s.actionsFor(req({ status: 'Approved', releaseAt: 100 }), wallet, m, 100).release, true);
});

t('outsiders get no actions, and stale requests take no votes', () => {
  assert.deepEqual(s.actionsFor(req({}), wallet, null, 0), { approve: false, reject: false, cancel: false, release: false });
  assert.equal(s.actionsFor(req({ stale: true }), wallet, { role: 'full' }, 0).approve, false);
  assert.equal(s.actionsFor(req({ status: 'Approved', stale: true, type: 'config', releaseAt: 1 }), wallet, { role: 'full' }, 9).release, false);
  assert.equal(s.actionsFor(req({ status: 'Approved', stale: true, releaseAt: 1 }), wallet, { role: 'full' }, 9).release, true);
});

t('amounts', () => {
  assert.equal(s.solAmount('1.5'), 1500000000n);
  assert.equal(s.solAmount('0.000000001'), 1n);
  assert.throws(() => s.solAmount('0'));
  assert.throws(() => s.solAmount('1.0000000001'));
  assert.throws(() => s.solAmount('abc'));
  assert.equal(s.tokenAmount('2.5', 6), 2500000n);
  assert.equal(s.tokenAmount('7', 0), 7n);
  assert.throws(() => s.tokenAmount('1.1', 0));
});

t('a large token request still packs under the limit', () => {
  const member = pk(), ms = pk(), mint = pk();
  const src = getAssociatedTokenAddressSync(mint, vault, true, TOKEN_2022_PROGRAM_ID);
  const dst = getAssociatedTokenAddressSync(mint, to, true, TOKEN_2022_PROGRAM_ID);
  const inner = createTransferCheckedInstruction(src, mint, dst, vault, 1n, 6, [], TOKEN_2022_PROGRAM_ID);
  const create = multisig.instructions.vaultTransactionCreate({
    multisigPda: ms, transactionIndex: 1n, creator: member, vaultIndex: 0, ephemeralSigners: 0,
    transactionMessage: new TransactionMessage({ payerKey: vault, recentBlockhash: hash, instructions: [inner] }),
  });
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(member, dst, to, mint, TOKEN_2022_PROGRAM_ID),
    create,
    multisig.instructions.proposalCreate({ multisigPda: ms, transactionIndex: 1n, creator: member }),
    multisig.instructions.proposalApprove({ multisigPda: ms, transactionIndex: 1n, member }),
  ];
  const txs = s.pack(member, hash, ixs);
  console.log('   token request:', txs.length, 'tx,', txs.map((x) => x.serialize().length), 'bytes');
  for (const tx of txs) assert.ok(tx.serialize().length <= s.MAX_TX_BYTES);
});

console.log(`${n} passed`);
process.exit(0);
