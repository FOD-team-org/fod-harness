import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
export interface MemorySample { freeMB: number; swapUsedGB: number; pressure: 'normal' | 'warning' }
export interface MemoryWatch { at: string; freeMB: number; swapUsedGB: number; over: boolean; overSince?: string; underSince?: string; critical?: boolean }
export function parseVmStat(text: string): number | undefined {
  const pageSize = Number(/page size of (\d+) bytes/u.exec(text)?.[1]);
  const free = /Pages free:\s*(\d+)/u.exec(text), inactive = /Pages inactive:\s*(\d+)/u.exec(text);
  if (!pageSize || !free || !inactive) return undefined;
  return (Number(free[1]) + Number(inactive[1])) * pageSize / 1024 ** 2;
}
export function parseSwapUsage(text: string): number | undefined {
  const match = /\bused\s*=\s*(\d+(?:\.\d+)?)\s*([MG])\b/iu.exec(text);
  return match ? Number(match[1]) / (match[2].toUpperCase() === 'M' ? 1024 : 1) : undefined;
}
const execute = promisify(execFile);
export type MemoryExec = (file: string, args: string[]) => Promise<{ stdout: string }>;
export async function sampleMemory(threshold = 8, run: MemoryExec = (file, args) => execute(file, args, { timeout: 3000 })): Promise<MemorySample | undefined> {
  try {
    const [vm, swap] = await Promise.all([run('vm_stat', []), run('sysctl', ['-n', 'vm.swapusage'])]);
    const freeMB = parseVmStat(vm.stdout), swapUsedGB = parseSwapUsage(swap.stdout);
    return freeMB === undefined || swapUsedGB === undefined ? undefined : { freeMB, swapUsedGB, pressure: swapUsedGB > threshold ? 'warning' : 'normal' };
  } catch { return undefined; }
}
export function judgeMemory(previous: MemoryWatch | undefined, sample: MemorySample, threshold = 8, now = Date.now()) {
  const at = new Date(now).toISOString(), watch: MemoryWatch = { ...previous, at, freeMB: sample.freeMB, swapUsedGB: sample.swapUsedGB, over: previous?.over ?? false };
  const events: { kind: 'memory-pressure' | 'memory-critical' | 'memory-recovered'; dedupeKey: string; swapUsedGB: number; freeMB: number }[] = [];
  const emit = (kind: typeof events[number]['kind'], since: string) => events.push({ kind, dedupeKey: `${kind}:${since}`, swapUsedGB: sample.swapUsedGB, freeMB: sample.freeMB });
  if (sample.swapUsedGB > threshold) {
    delete watch.underSince;
    if (!watch.overSince) {
      watch.over = true; watch.overSince = at;
      emit('memory-pressure', at);
    } else if (!watch.critical && now - Date.parse(watch.overSince) >= 300000) {
      watch.critical = true; emit('memory-critical', watch.overSince);
    }
  } else {
    // Critical requires uninterrupted over-threshold observations; recovery keeps
    // hysteresis through the neutral band and needs five uninterrupted low minutes.
    delete watch.overSince;
    if (watch.over && sample.swapUsedGB < threshold - 2) {
      watch.underSince ??= at;
      if (now - Date.parse(watch.underSince) >= 300000) {
        emit('memory-recovered', watch.underSince); watch.over = false; watch.critical = false; delete watch.underSince;
      }
    } else delete watch.underSince;
  }
  return { watch, events };
}
