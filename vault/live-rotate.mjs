// Second half of live-check.mjs on an existing vault: key change, then a full move with the new key.
// node live-rotate.mjs <multisig>
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as s from './sloth.mjs';

const WAIT = 60;
const multisigPda = process.argv[2];
const connection = new Connection(process.env.RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
const [main, backup, guardian, newGuardian] = JSON.parse(readFileSync('.live-keys.json')).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function send(ixs, signers, tables = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  for (const tx of s.pack(signers[0].publicKey, blockhash, ixs, tables)) {
    tx.sign(signers);
    const sig = await connection.sendRawTransaction(tx.serialize());
    const { value } = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    if (value.err) throw new Error(`${sig} ${JSON.stringify(value.err)}`);
  }
  await sleep(2500);
}
async function refused(ixs, signers) {
  const { blockhash } = await connection.getLatestBlockhash();
  const [tx] = s.pack(signers[0].publicKey, blockhash, ixs);
  tx.sign(signers);
  const { value } = await connection.simulateTransaction(tx, { sigVerify: true });
  assert.ok(value.err, 'expected the chain to refuse this');
  return (value.logs || []).find((l) => l.includes('Error Code'))?.match(/Error Code: (\w+)/)?.[1] ?? JSON.stringify(value.err);
}

const start = await connection.getBalance(main.publicKey);
console.log('main', start / LAMPORTS_PER_SOL, 'SOL');
let v = await s.readVault(connection, multisigPda);
const pending = v.requests.find((r) => r.status === 'Active');
console.log('open request', pending?.index);

const rot = await s.buildRotate({ connection, multisigPda, member: main.publicKey, oldKey: guardian.publicKey, newKey: newGuardian.publicKey });
await send(rot.ixs, [main]);
console.log('key change request cost', (start - await connection.getBalance(main.publicKey)) / LAMPORTS_PER_SOL, 'SOL');
await send(s.buildApprove({ multisigPda, member: backup.publicKey, index: rot.index }), [backup]);
v = await s.readVault(connection, multisigPda);
const r = v.requests.find((x) => x.index === Number(rot.index));
assert.equal(r.type, 'config');
assert.equal(r.move.kind, 'rotate');
assert.equal(r.status, 'Approved');
const change = await s.buildRelease({ connection, multisigPda, member: main.publicKey, index: rot.index, kind: 'config' });
console.log('key change during wait:', await refused(change.ixs, [main]));
await sleep((WAIT + 3) * 1000);
await send(change.ixs, [main]);
v = await s.readVault(connection, multisigPda);
assert.ok(v.members.some((m) => m.key === newGuardian.publicKey.toBase58() && m.role === 'vote'));
assert.ok(!v.members.some((m) => m.key === guardian.publicKey.toBase58()));
console.log('key changed, stale index', v.stale);

if (pending) {
  assert.equal(v.requests.find((x) => x.index === pending.index).stale, true);
  console.log('open request after change:', await refused(s.buildApprove({ multisigPda, member: backup.publicKey, index: pending.index }), [backup]));
}
console.log('old guardian vote:', await refused(s.buildApprove({ multisigPda, member: guardian.publicKey, index: v.last }), [guardian]));

const before = await connection.getBalance(main.publicKey);
const w = await s.buildWithdraw({ connection, multisigPda, member: main.publicKey, to: main.publicKey, amount: BigInt(v.lamports) });
await send(w.ixs, [main]);
console.log('withdraw request cost', (before - await connection.getBalance(main.publicKey)) / LAMPORTS_PER_SOL, 'SOL');
await sleep(500);
const fund = await connection.getBalance(newGuardian.publicKey);
console.log('new guardian balance', fund);
console.log(`done, vault still holds ${v.lamports} lamports with request ${w.index} open`);
process.exit(0);
