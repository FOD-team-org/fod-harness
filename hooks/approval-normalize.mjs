import { basename } from 'node:path';
import { commandWords, shellCommands } from './shell-commands.mjs';

const npmValues = ['--prefix', '-C', '-w', '--workspace', '--loglevel', '--registry', '--userconfig', '--cache', '--scope', '--tag'];
const npmFlags = ['-s', '--silent', '-q', '--quiet', '--if-present', '-ws', '--workspaces', '--include-workspace-root', '--verbose', '-d', '-dd', '-y', '--yes'];
const builtins = {
  pnpm: 'install i add update up remove rm uninstall link unlink import rebuild prune fetch patch patch-commit audit list ls outdated why licenses run exec test t start dlx create init publish pack store root bin setup env config c get set deploy doctor server recursive multi m sbom self-update cat-file cat-index find-hash approve-builds ignored-builds',
  yarn: 'add install remove upgrade up info why init run test start exec dlx workspace workspaces config cache pack publish link unlink bin global list outdated audit version set plugin node constraints explain npm patch rebuild stage unplug dedupe',
  bun: 'run test x repl exec install i add a remove rm update outdated link unlink pm build init create upgrade publish audit info patch',
};
function strip(words, values, flags = []) {
  const out = []; let literal = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (literal) { out.push(word); continue; }
    if (word === '--') { literal = true; out.push(word); continue; }
    if (flags.includes(word)) continue;
    if (values.includes(word)) { i++; continue; }
    if (values.some(option => word.startsWith(option + '=') || /^-[^-]$/.test(option) && word.startsWith(option) && word.length > 2)) continue;
    out.push(word);
  }
  return out;
}
export function npmWords(words) { return strip(words, npmValues, npmFlags); }
export function approvalForms(words) {
  let original;
  try { original = commandWords(words); } catch { return [words]; }
  const forms = [], seen = new Set();
  const add = (form, raw = false) => {
    const id = JSON.stringify([form, raw]);
    if (seen.has(id) || forms.length >= 32) return false;
    seen.add(id); if (raw) Object.defineProperty(form, 'raw', { value: true });
    forms.push(form); return true;
  };
  const visit = (input, depth) => {
    if (depth > 3 || forms.length >= 32) return;
    const args = commandWords(input); add(args);
    const exe = basename(args[0] ?? '');
    const prefix = input.slice(0, input.length - args.length);
    const callSource = ['npm'].includes(exe) && npmWords(args).some(w => ['exec', 'x'].includes(w)) ? args
      : prefix.some(w => ['npx', 'bunx'].includes(basename(w))) ? prefix : [];
    for (let i = 0; i < callSource.length; i++) {
      const word = callSource[i];
      const value = ['-c', '--call'].includes(word) ? callSource[++i] : /^--call=/.test(word) ? word.slice(7) : /^-c.+/.test(word) ? word.slice(2) : undefined;
      if (value === undefined) continue;
      const parsed = shellCommands(value, { extended: true });
      if (parsed.unresolved) add([value], true);
      for (const entry of parsed.entries) visit(entry.words, depth + 1);
    }
    const emit = form => { if (depth < 3 && add(form)) visit(form, depth + 1); };
    if (exe === 'node') for (let i = 1; i < args.length; i++) {
      if (args[i] === '--run' && args[i + 1]) emit(['npm', 'run', ...args.slice(i + 1)]);
      else if (args[i].startsWith('--run=')) emit(['npm', 'run', args[i].slice(6), ...args.slice(i + 1)]);
    }
    if (!['npm', 'pnpm', 'yarn', 'bun'].includes(exe)) return;
    const clean = exe === 'npm' ? npmWords(args).slice(1)
      : exe === 'pnpm' ? strip(args.slice(1), ['-C', '--dir', '--filter', '-F', '--reporter'], ['-r', '--recursive', '-w', '--workspace-root', '-s', '--silent', '--if-present', '--parallel', '--stream'])
      : strip(args.slice(1), ['--cwd']);
    for (let i = 0; i < clean.length && clean[i] !== '--'; i++) {
      const action = clean[i], rest = clean.slice(i + 1);
      if (action.startsWith('-')) continue;
      if (exe === 'yarn' && action === 'workspace') { if (rest.length > 1) visit(['yarn', ...rest.slice(1)], depth + 1); break; }
      if (exe === 'npm') {
        if (['run', 'run-script', 'rum', 'urn'].includes(action) && rest.length) emit(['npm', 'run', ...rest]);
        else if (['test', 't', 'tst', 'start', 'stop', 'restart'].includes(action)) emit(['npm', 'run', ['t', 'tst'].includes(action) ? 'test' : action, ...rest]);
        else if (['exec', 'x'].includes(action)) {
          const target = strip(rest, ['--package', '-p', '-c', '--call'], ['--yes', '-y', '--no']).filter(w => w !== '--');
          if (target.length) emit(target);
        }
      } else if (action === 'run' && rest.length) { emit(['npm', 'run', ...rest]); emit(rest); }
      else if (action === 'exec' || exe === 'bun' && action === 'x') { if (rest.length) emit(rest.filter(w => w !== '--')); }
      else if (exe === 'pnpm' && ['test', 't', 'start'].includes(action)) emit(['npm', 'run', action === 't' ? 'test' : action, ...rest]);
      else if (!builtins[exe].split(' ').includes(action)) { emit(['npm', 'run', action, ...rest]); emit([action, ...rest]); }
    }
  };
  try { visit(words, 0); return forms; } catch { return [original]; }
}
