// Runs a whole vault life on mainnet with throwaway keys and a 60 s wait.
// Fund the address it prints with 0.03 SOL, then run it again. RPC=<url> overrides the public one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import * as s from './sloth.mjs';

const WAIT = 60;
const FILE = '.live-keys.json';
const connection = new Connection(process.env.RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');

if (!existsSync(FILE)) {
  const fresh = ['main', 'backup', 'guardian', 'newGuardian', 'dest'].map(() => [...Keypair.generate().secretKey]);
  writeFileSync(FILE, JSON.stringify(fresh));
}
const [main, backup, guardian, newGuardian, dest] = JSON.parse(readFileSync(FILE)).map((k) => Keypair.fromSecretKey(Uint8Array.from(k)));
const start = await connection.getBalance(main.publicKey);
console.log('main', main.publicKey.toBase58(), start / LAMPORTS_PER_SOL, 'SOL');
if (start < 0.02 * LAMPORTS_PER_SOL) { console.log('fund it with 0.03 SOL and run again'); process.exit(0); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function send(ixs, signers, tables = []) {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash();
  const txs = s.pack(signers[0].publicKey, blockhash, ixs, tables);
  let sig;
  for (const tx of txs) {
    tx.sign(signers);
    sig = await connection.sendRawTransaction(tx.serialize());
    const { value } = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight });
    if (value.err) throw new Error(`${sig} ${JSON.stringify(value.err)}`);
  }
  return sig;
}
async function refused(ixs, signers, tables = []) {
  const { blockhash } = await connection.getLatestBlockhash();
  const [tx] = s.pack(signers[0].publicKey, blockhash, ixs, tables);
  tx.sign(signers);
  const { value } = await connection.simulateTransaction(tx, { sigVerify: true });
  assert.ok(value.err, 'expected the chain to refuse this');
  return (value.logs || []).find((l) => l.includes('Error Code')) || JSON.stringify(value.err);
}
const request = async (ms, index) => { await sleep(1500); return (await s.readVault(connection, ms)).requests.find((r) => r.index === Number(index)); };

const { createKey, multisigPda, vault, ixs } = await s.buildCreate({
  connection, creator: main.publicKey, backup: backup.publicKey, guardian: guardian.publicKey, timeLock: WAIT, anyWait: true,
});
await send([
  ...ixs,
  SystemProgram.transfer({ fromPubkey: main.publicKey, toPubkey: backup.publicKey, lamports: 1500000 }),
  SystemProgram.transfer({ fromPubkey: main.publicKey, toPubkey: guardian.publicKey, lamports: 1500000 }),
  SystemProgram.transfer({ fromPubkey: main.publicKey, toPubkey: vault, lamports: 4000000 }),
], [main, createKey]);
console.log('vault created', multisigPda.toBase58(), 'funds at', vault.toBase58());

// A stolen main key alone
const w1 = await s.buildWithdraw({ connection, multisigPda, member: main.publicKey, to: dest.publicKey, amount: 1000000n });
await send(w1.ixs, [main]);
let r = await request(multisigPda, w1.index);
assert.equal(r.status, 'Active');
assert.equal(r.move.kind, 'sol');
assert.equal(r.move.lamports, 1000000n);
const early = await s.buildRelease({ connection, multisigPda, member: main.publicKey, index: w1.index });
console.log('main key alone, release refused:', await refused(early.ixs, [main]));

// Second key starts the wait
await send(s.buildApprove({ multisigPda, member: backup.publicKey, index: w1.index }), [backup]);
r = await request(multisigPda, w1.index);
assert.equal(r.status, 'Approved');
console.log('approved, release refused during wait:', await refused(early.ixs, [main]));

// The guardian can vote but cannot propose or release
const g = await s.buildWithdraw({ connection, multisigPda, member: guardian.publicKey, to: guardian.publicKey, amount: 1000000n });
console.log('guardian proposal refused:', await refused(g.ixs, [guardian]));
await sleep((WAIT + 3) * 1000);
const byGuardian = await s.buildRelease({ connection, multisigPda, member: guardian.publicKey, index: w1.index });
console.log('guardian release refused:', await refused(byGuardian.ixs, [guardian]));
const out = await s.buildRelease({ connection, multisigPda, member: backup.publicKey, index: w1.index });
console.log('released', await send(out.ixs, [backup], out.tables));
await sleep(1500);
assert.equal(await connection.getBalance(dest.publicKey), 1000000);

// One cancel does not stop a request; the threshold does
const w2 = await s.buildWithdraw({ connection, multisigPda, member: main.publicKey, to: dest.publicKey, amount: 500000n });
await send(w2.ixs, [main]);
await send(s.buildApprove({ multisigPda, member: guardian.publicKey, index: w2.index }), [guardian]);
await send(s.buildCancel({ multisigPda, member: guardian.publicKey, index: w2.index }), [guardian]);
r = await request(multisigPda, w2.index);
assert.equal(r.status, 'Approved');
console.log('one cancel: still approved, cancelled by', r.cancelled.length);
await send(s.buildCancel({ multisigPda, member: backup.publicKey, index: w2.index }), [backup]);
r = await request(multisigPda, w2.index);
assert.equal(r.status, 'Cancelled');
console.log('two cancels: cancelled');

// Key change waits too, and voids open requests
const w3 = await s.buildWithdraw({ connection, multisigPda, member: main.publicKey, to: dest.publicKey, amount: 400000n });
await send(w3.ixs, [main]);
const rot = await s.buildRotate({ connection, multisigPda, member: backup.publicKey, oldKey: guardian.publicKey, newKey: newGuardian.publicKey });
await send(rot.ixs, [backup]);
await send(s.buildApprove({ multisigPda, member: main.publicKey, index: rot.index }), [main]);
r = await request(multisigPda, rot.index);
assert.equal(r.type, 'config');
assert.equal(r.move.kind, 'rotate');
const change = await s.buildRelease({ connection, multisigPda, member: main.publicKey, index: rot.index, kind: 'config' });
console.log('key change refused during wait:', await refused(change.ixs, [main]));
await sleep((WAIT + 3) * 1000);
await send(change.ixs, [main]);
const after = await (async () => { await sleep(1500); return s.readVault(connection, multisigPda); })();
assert.ok(after.members.some((m) => m.key === newGuardian.publicKey.toBase58() && m.role === 'vote'));
assert.ok(!after.members.some((m) => m.key === guardian.publicKey.toBase58()));
r = after.requests.find((x) => x.index === Number(w3.index));
assert.equal(r.stale, true);
console.log('key changed, open request voided:', await refused(s.buildApprove({ multisigPda, member: backup.publicKey, index: w3.index }), [backup]));

const end = await connection.getBalance(main.publicKey);
console.log(`done. multisig ${multisigPda.toBase58()}. spent by main: ${(start - end) / LAMPORTS_PER_SOL} SOL`);
process.exit(0);
