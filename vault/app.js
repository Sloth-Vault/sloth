import { Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import * as s from './sloth.mjs';

const STORE = 'sloth.vaults';
const REFRESH_MS = 20000;
const CONFIRM_MS = 90000;
const connection = new Connection(`${location.origin}/rpc`, { commitment: 'confirmed', disableRetryOnRateLimit: true });

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const short = (k) => { const t = String(k); return `${t.slice(0, 4)}…${t.slice(-4)}`; };
const two = (n) => String(n).padStart(2, '0');

const state = { wallet: null, data: null, error: '', busy: '', view: 'home' };

function getProvider() {
  return window.phantom?.solana ?? window.solflare ?? window.solana ?? null;
}

function saved() {
  try { return JSON.parse(localStorage.getItem(STORE)) || []; } catch { return []; }
}
function remember(address) {
  try { localStorage.setItem(STORE, JSON.stringify([address, ...saved().filter((a) => a !== address)].slice(0, 8))); } catch { /* the link still opens it */ }
}

function formatUnits(raw, decimals) {
  const text = BigInt(raw).toString().padStart(decimals + 1, '0');
  const whole = text.slice(0, text.length - decimals);
  const part = decimals ? text.slice(-decimals).replace(/0+$/, '') : '';
  return part ? `${whole}.${part}` : whole;
}
const sol = (lamports) => formatUnits(lamports, 9);

function duration(seconds) {
  const v = Math.max(0, seconds);
  if (v >= 172800) return `${Math.round(v / 86400)} days`;
  return `${two(Math.floor(v / 3600))}:${two(Math.floor(v / 60) % 60)}:${two(Math.floor(v) % 60)}`;
}
function waitName(seconds) {
  const name = Object.entries(s.TIME_LOCKS).find(([, v]) => v === seconds);
  return name ? name[0] : `${seconds} s`;
}

function parseKey(text, label) {
  try { return new PublicKey(String(text).trim()); } catch { throw new Error(`${label} isn't a Solana address`); }
}

async function confirm(signature) {
  const end = Date.now() + CONFIRM_MS;
  while (Date.now() < end) {
    const { value } = await connection.getSignatureStatuses([signature]);
    const st = value[0];
    if (st?.err) throw new Error('The chain refused this transaction');
    if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Not confirmed yet. Check ${short(signature)} on an explorer before trying again`);
}

async function send(ixs, extraSigner, tables = []) {
  const provider = getProvider();
  const payer = new PublicKey(state.wallet);
  const { blockhash } = await connection.getLatestBlockhash();
  for (const tx of s.pack(payer, blockhash, ixs, tables)) {
    if (extraSigner) {
      // The wallet signs first: it may add instructions, which would void an earlier signature.
      const signed = await provider.signTransaction(tx);
      signed.sign([extraSigner]);
      await confirm(await connection.sendRawTransaction(signed.serialize()));
    } else {
      const { signature } = await provider.signAndSendTransaction(tx);
      await confirm(signature);
    }
  }
}

async function run(label, fn) {
  state.busy = label; state.error = ''; render();
  try {
    await fn();
  } catch (e) {
    const text = e?.message ?? '';
    state.error = /rejected|cancel/i.test(text) ? 'Cancelled in the wallet'
      : /insufficient|rent/i.test(text) ? 'This wallet needs more SOL. A new request costs about 0.004 SOL in rent'
      : (text || 'Something failed');
  }
  state.busy = ''; render();
}

async function connectWallet() {
  const provider = getProvider();
  if (!provider) { state.error = 'No Solana wallet found in this browser'; render(); return; }
  await run('Connecting', async () => {
    const res = await provider.connect();
    state.wallet = (res?.publicKey ?? provider.publicKey).toString();
    provider.on?.('accountChanged', (k) => { state.wallet = k ? k.toString() : null; render(); });
  });
}

async function load(address) {
  state.data = await s.readVault(connection, address);
  state.view = 'vault';
  remember(state.data.multisigPda.toBase58());
  if (location.hash.slice(1) !== state.data.multisigPda.toBase58()) history.replaceState(null, '', `#${state.data.multisigPda.toBase58()}`);
}

const reload = () => load(state.data.multisigPda);
const me = () => state.data?.members.find((m) => m.key === state.wallet) ?? null;

function moveText(r) {
  const m = r.move;
  if (m.kind === 'sol') return { what: `${sol(m.lamports)} SOL`, where: m.to.toBase58() };
  if (m.kind === 'token') return { what: `${formatUnits(m.amount, m.decimals)} of ${short(m.mint)}`, where: m.to ? m.to.toBase58() : 'unknown owner' };
  if (m.kind === 'rotate') return { what: `Replace key ${short(m.oldKey)}`, where: m.newKey.toBase58() };
  return null;
}

function statusText(r, now) {
  if (r.status === 'Active') return r.stale ? 'Void, a key changed' : `Needs a second key (${r.approved.length} of 2)`;
  if (r.status === 'Approved') return now >= r.releaseAt ? 'Ready to release' : 'Waiting';
  return { Executed: 'Released', Cancelled: 'Cancelled', Rejected: 'Rejected', Draft: 'Draft', NoProposal: 'Never opened' }[r.status] ?? r.status;
}

const isOpen = (r) => (r.status === 'Active' && !r.stale) || r.status === 'Approved';

function requestRow(r, now) {
  const text = moveText(r);
  const act = s.actionsFor(r, state.wallet, me(), now);
  const open = isOpen(r);
  const unknown = !text;
  const buttons = [
    act.approve && !unknown ? `<button class="btn" data-do="approve" data-i="${r.index}">Approve</button>` : '',
    act.reject ? `<button class="btn ghost" data-do="reject" data-i="${r.index}">Reject</button>` : '',
    act.cancel ? `<button class="btn ghost" data-do="cancel" data-i="${r.index}">Cancel</button>` : '',
    act.release && !unknown ? `<button class="btn" data-do="release" data-i="${r.index}" data-type="${r.type}">Release</button>` : '',
  ].join('');
  return `<li class="req ${open ? 'open' : 'closed'}">
    <div class="req-top"><span class="mono">#${r.index}</span><b>${esc(statusText(r, now))}</b>${r.status === 'Approved' && now < r.releaseAt ? `<span class="mono timer" data-release="${r.releaseAt}">${duration(r.releaseAt - now)}</span>` : ''}</div>
    ${unknown
      ? `<p class="warn">This site can't read this request as a plain transfer. Do not approve it${r.type === 'vault' || r.type === 'config' ? '' : ' or trust it'}.</p>`
      : `<p class="move"><b>${esc(text.what)}</b><span>${r.move.kind === 'rotate' ? 'new key' : 'to'} <code>${esc(text.where)}</code></span></p>`}
    ${r.status === 'Approved' && r.stale && r.type === 'vault' ? '<p class="warn">Approved before a key change, so it can still be released. If it isn\'t yours, two keys must cancel it.</p>' : ''}
    ${open && r.cancelled.length ? `<p class="note">${r.cancelled.length} of 2 cancels so far</p>` : ''}
    ${buttons ? `<div class="row">${buttons}</div>` : ''}
  </li>`;
}

function vaultView() {
  const d = state.data;
  const member = me();
  const now = Math.floor(Date.now() / 1000);
  const vault = d.vault.toBase58();
  const link = `${location.origin}/app/#${d.multisigPda.toBase58()}`;
  const open = d.requests.filter(isOpen);
  const closed = d.requests.filter((r) => !open.includes(r));
  return `
  <div class="stat"><span>Savings</span><h2>${esc(sol(d.lamports))} SOL</h2>
    ${d.tokens.map((t) => `<p class="mono token">${esc(t.ui)} <span>${esc(short(t.mint))}</span></p>`).join('')}
    <p class="note">Every move needs 2 of 3 keys and waits ${esc(waitName(d.timeLock))}. Each new request costs its creator about 0.004 SOL in rent.</p></div>
  ${member || !state.wallet ? '' : '<p class="warn">The connected wallet isn\'t a key on this vault, so you can only read it.</p>'}

  <h3>Deposit</h3>
  <p class="note">Vault address. Send funds only here: <code>${esc(vault)}</code> <button class="link" data-copy="${esc(vault)}">Copy</button></p>
  ${state.wallet ? `<form data-form="deposit" class="row"><input name="amount" inputmode="decimal" placeholder="SOL" aria-label="SOL to deposit" required><button class="btn">Deposit</button></form>` : ''}

  ${member?.role === 'full' ? `<h3>New request</h3>
  <form data-form="withdraw" class="stack">
    <select name="asset" aria-label="Asset"><option value="">SOL</option>${d.tokens.map((t) => `<option value="${esc(t.mint)}" data-decimals="${t.decimals}">${esc(short(t.mint))}</option>`).join('')}</select>
    <input name="to" placeholder="Destination address" aria-label="Destination address" required autocomplete="off">
    <input name="amount" inputmode="decimal" placeholder="Amount" aria-label="Amount" required>
    <button class="btn">Ask to withdraw</button>
  </form>` : ''}

  <h3>Requests</h3>
  ${open.length ? `<ul class="reqs">${open.map((r) => requestRow(r, now)).join('')}</ul>` : '<p class="note">Nothing is waiting.</p>'}
  ${closed.length ? `<details><summary>History</summary><ul class="reqs">${closed.map((r) => requestRow(r, now)).join('')}</ul></details>` : ''}

  <h3>Keys</h3>
  <ul class="keys">${d.members.map((k) => {
    const name = k.role === 'vote' ? 'Guardian' : 'Full key';
    return `<li><b>${esc(name)}${k.key === state.wallet ? ' (you)' : ''}</b><code>${esc(k.key)}</code>${member?.role === 'full' ? `<button class="link" data-replace="${esc(k.key)}">Replace</button>` : ''}</li>`;
  }).join('')}</ul>
  ${state.replacing ? `<form data-form="rotate" class="stack"><p class="note">Replace ${esc(short(state.replacing))}. A second key must approve, then it waits ${esc(waitName(d.timeLock))}. Requests still waiting for votes become void.</p><input name="key" placeholder="New key address" aria-label="New key address" required autocomplete="off"><button class="btn">Ask to replace</button></form>` : ''}

  <h3>Share with your other keys</h3>
  <p class="note">Open this link on the backup and guardian wallets: <code>${esc(link)}</code> <button class="link" data-copy="${esc(link)}">Copy</button></p>`;
}

function homeView() {
  const list = saved();
  return `
  <h2 class="title">Open a slow vault</h2>
  <p class="note">The connected wallet becomes the main key. Use a different wallet for each of the three keys, each on its own device. A guardian you trust can be a friend's wallet. If two keys are lost, the funds are stuck for good.</p>
  ${state.wallet ? `<form data-form="create" class="stack">
    <input name="backup" placeholder="Backup wallet address" aria-label="Backup wallet address" required autocomplete="off">
    <input name="guardian" placeholder="Guardian wallet address" aria-label="Guardian wallet address" required autocomplete="off">
    <select name="wait" aria-label="Wait">${Object.entries(s.TIME_LOCKS).map(([k, v]) => `<option value="${v}">Wait ${k}</option>`).join('')}</select>
    <label class="check"><input type="checkbox" name="ok" required> I can't change these three keys or the wait without a second key and the full wait.</label>
    <button class="btn">Create vault</button>
  </form>` : '<button class="btn" data-do="connect">Connect wallet</button>'}
  <h3>Already have one</h3>
  <form data-form="open" class="row"><input name="address" placeholder="Vault link or address" aria-label="Vault link or address" required autocomplete="off"><button class="btn ghost">Open</button></form>
  ${list.length ? `<ul class="saved">${list.map((a) => `<li><button class="link" data-open="${esc(a)}">${esc(short(a))}</button></li>`).join('')}</ul>` : ''}`;
}

function render() {
  $('wallet').textContent = state.wallet ? short(state.wallet) : 'Connect';
  $('banner').innerHTML = state.busy
    ? `<p class="busy">${esc(state.busy)}…</p>`
    : state.error ? `<p class="warn">${esc(state.error)}</p>` : '';
  const open = document.activeElement?.closest?.('form');
  if (open && !state.busy && open.dataset.form) return; // keep what is being typed; a refresh waits
  $('body').innerHTML = state.view === 'vault' ? vaultView() : homeView();
}

const actions = {
  connect: connectWallet,
  approve: (i) => run('Approving', async () => { await send(s.buildApprove({ multisigPda: state.data.multisigPda, member: state.wallet, index: i })); await reload(); }),
  reject: (i) => run('Rejecting', async () => { await send(s.buildReject({ multisigPda: state.data.multisigPda, member: state.wallet, index: i })); await reload(); }),
  cancel: (i) => run('Cancelling', async () => { await send(s.buildCancel({ multisigPda: state.data.multisigPda, member: state.wallet, index: i })); await reload(); }),
  release: (i, type) => run('Releasing', async () => {
    const { ixs, tables } = await s.buildRelease({ connection, multisigPda: state.data.multisigPda, member: state.wallet, index: i, kind: type });
    await send(ixs, null, tables);
    await reload();
  }),
};

const forms = {
  create: (f) => run('Creating vault', async () => {
    const { createKey, multisigPda, ixs } = await s.buildCreate({
      connection, creator: state.wallet,
      backup: parseKey(f.backup.value, 'Backup'), guardian: parseKey(f.guardian.value, 'Guardian'),
      timeLock: Number(f.wait.value),
    });
    await send(ixs, createKey);
    await load(multisigPda);
  }),
  open: (f) => run('Opening', async () => {
    const text = f.address.value.trim();
    await load(parseKey(text.slice(text.lastIndexOf('#') + 1), 'Vault'));
  }),
  deposit: (f) => run('Depositing', async () => {
    const lamports = s.solAmount(f.amount.value);
    await send([SystemProgram.transfer({ fromPubkey: new PublicKey(state.wallet), toPubkey: state.data.vault, lamports })]);
    await reload();
  }),
  withdraw: (f) => run('Asking', async () => {
    const option = f.asset.selectedOptions[0];
    const to = parseKey(f.to.value, 'Destination');
    const mint = f.asset.value || null;
    const decimals = mint ? Number(option.dataset.decimals) : 9;
    const amount = mint ? s.tokenAmount(f.amount.value, decimals) : s.solAmount(f.amount.value);
    const { ixs } = await s.buildWithdraw({ connection, multisigPda: state.data.multisigPda, member: state.wallet, to, amount, mint, decimals });
    await send(ixs);
    await reload();
  }),
  rotate: (f) => run('Asking', async () => {
    const { ixs } = await s.buildRotate({
      connection, multisigPda: state.data.multisigPda, member: state.wallet,
      oldKey: state.replacing, newKey: parseKey(f.key.value, 'New key'),
    });
    await send(ixs);
    state.replacing = null;
    await reload();
  }),
};

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.id === 'wallet') { if (!state.wallet) connectWallet(); return; }
  if (b.dataset.do) actions[b.dataset.do](Number(b.dataset.i), b.dataset.type);
  if (b.dataset.copy) navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; });
  if (b.dataset.open) run('Opening', () => load(b.dataset.open));
  if (b.dataset.replace) { state.replacing = b.dataset.replace; render(); }
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  document.activeElement?.blur();
  forms[form.dataset.form]?.(form.elements);
});

setInterval(() => {
  const now = Date.now() / 1000;
  document.querySelectorAll('[data-release]').forEach((el) => {
    const left = Number(el.dataset.release) - now;
    if (left <= 0) render(); else el.textContent = duration(left);
  });
}, 1000);

setInterval(() => {
  if (state.view === 'vault' && !state.busy && !document.hidden) reload().then(render).catch(() => {});
}, REFRESH_MS);

const win = $('window');
$('bar').addEventListener('pointerdown', (e) => {
  if (innerWidth < 760 || e.target.closest('button')) return;
  const box = win.getBoundingClientRect();
  const dx = e.clientX - box.left, dy = e.clientY - box.top;
  const move = (m) => {
    win.style.left = `${Math.max(0, Math.min(innerWidth - 120, m.clientX - dx))}px`;
    win.style.top = `${Math.max(48, Math.min(innerHeight - 60, m.clientY - dy))}px`;
    win.style.margin = '0';
  };
  const stop = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', stop); };
  addEventListener('pointermove', move);
  addEventListener('pointerup', stop);
});

window.__sloth = state;

const start = location.hash.slice(1);
if (start) run('Opening', () => load(parseKey(start, 'Vault'))); else render();
getProvider()?.connect?.({ onlyIfTrusted: true }).then((res) => { state.wallet = res.publicKey.toString(); render(); }).catch(() => {});
