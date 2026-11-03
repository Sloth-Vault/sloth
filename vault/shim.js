import { Buffer } from 'buffer';

globalThis.Buffer = Buffer;
globalThis.process = globalThis.process || { env: {}, browser: true, version: '', versions: {}, nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)) };
export { Buffer };
