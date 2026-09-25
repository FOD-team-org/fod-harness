import { randomUUID } from 'node:crypto';
import { appendLedger } from './ledger.ts';

export const shutdownWaitMs = 5000;
export async function waitForShutdown(root: string, extension: string, pending: (Promise<unknown> | undefined)[], waitedMs = shutdownWaitMs, onTimeout?: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = await Promise.race([
      Promise.allSettled(pending).then(() => false),
      new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), waitedMs); }),
    ]);
    if (timedOut) {
      onTimeout?.();
      await appendLedger(root, { runId: randomUUID(), action: 'shutdown:timeout', status: 'warn', evidence: { extension, waitedMs } });
    }
  } finally { clearTimeout(timer); }
}
