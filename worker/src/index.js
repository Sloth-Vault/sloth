// Serves the site and forwards a short list of read and send calls to the RPC, so the key stays here.
const ALLOWED = new Set([
  'getAccountInfo', 'getMultipleAccounts', 'getBalance', 'getLatestBlockhash', 'getTokenAccountsByOwner',
  'sendTransaction', 'simulateTransaction', 'getSignatureStatuses', 'getBlockHeight',
]);
const MAX_BODY = 64 * 1024;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
const rpcError = (id, message, status) => json({ jsonrpc: '2.0', id: id ?? null, error: { code: -32000, message } }, status);

async function rpc(request, env) {
  if (request.method !== 'POST') return rpcError(null, 'POST only', 405);
  if (!env.SOL_RPC_URL) return rpcError(null, 'RPC is not set', 503);
  const text = await request.text();
  if (text.length > MAX_BODY) return rpcError(null, 'Too large', 413);
  let call;
  try { call = JSON.parse(text); } catch { return rpcError(null, 'Bad JSON', 400); }
  if (Array.isArray(call) || !ALLOWED.has(call?.method)) return rpcError(call?.id, 'Method not allowed', 403);
  const upstream = await fetch(env.SOL_RPC_URL, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: text,
  });
  return new Response(upstream.body, {
    status: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname === '/rpc') return rpc(request, env);
    return env.ASSETS.fetch(request);
  },
};
