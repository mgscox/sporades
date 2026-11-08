import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { freemem } from 'node:os';
import path from 'node:path';

const mb = bytes => bytes / 1024 / 1024;
const read = file => { try { return readFileSync(file, 'utf8'); } catch { return ''; } };
const pageBytes = process.platform === 'linux'
  ? Number(spawnSync('getconf', ['PAGESIZE'], { encoding: 'utf8', timeout: 1000, killSignal: 'SIGKILL' }).stdout) || 4096 : 4096;

// Include birth time in ownership: a recycled PID must never become ours.
export function processes() {
  if (process.platform === 'linux') {
    return readdirSync('/proc').filter(name => /^\d+$/.test(name)).flatMap(name => {
      const stat = read(`/proc/${name}/stat`);
      if (!stat) return [];
      const fields = stat.slice(stat.lastIndexOf(') ') + 2).split(' ');
      return [{ pid: Number(name), parent: Number(fields[1]), group: Number(fields[2]), birth: fields[19], rssMb: mb(Number(fields[21]) * pageBytes) }];
    });
  }
  const output = spawnSync('ps', ['-axo', 'pid=,ppid=,pgid=,rss=,lstart='], { encoding: 'utf8', timeout: 1000 }).stdout || '';
  return output.trim().split('\n').filter(Boolean).map(line => {
    const [pid, parent, group, rss, ...birth] = line.trim().split(/\s+/);
    return { pid: Number(pid), parent: Number(parent), group: Number(group), birth: birth.join(' '), rssMb: Number(rss) / 1024 };
  });
}

// Respect a container's memory boundary as well as the host's MemAvailable.
const cgroupPath = read('/proc/self/cgroup').split('\n').find(line => line.startsWith('0::'))?.slice(3);
const cgroups = ['/sys/fs/cgroup'];
for (let parent = cgroupPath; parent && parent !== '/'; parent = path.posix.dirname(parent)) cgroups.push(path.posix.join('/sys/fs/cgroup', parent));
export function systemMemory() {
  const info = Object.fromEntries([...read('/proc/meminfo').matchAll(/^(\w+):\s+(\d+) kB/gm)].map(([, key, value]) => [key, Number(value) / 1024]));
  let freeMb = info.MemAvailable ?? mb(freemem());
  let swapFreeMb = info.SwapFree ?? null;
  let oomKills = 0;
  for (const dir of cgroups) {
    const limit = Number(read(`${dir}/memory.max`).trim());
    const used = Number(read(`${dir}/memory.current`).trim());
    if (limit > 0 && Number.isFinite(limit)) freeMb = Math.min(freeMb, mb(limit - used));
    const swapRaw = read(`${dir}/memory.swap.max`).trim();
    const swapLimit = Number(swapRaw);
    if (swapRaw && swapLimit >= 0 && Number.isFinite(swapLimit)) swapFreeMb = Math.min(swapFreeMb ?? Infinity, mb(swapLimit - Number(read(`${dir}/memory.swap.current`).trim())));
    const events = read(`${dir}/memory.events.local`) || (dir === path.posix.join('/sys/fs/cgroup', cgroupPath ?? '') ? read(`${dir}/memory.events`) : '');
    oomKills += Number(events.match(/^oom_kill (\d+)/m)?.[1] || 0);
  }
  return { freeMb, swapFreeMb, oomKills };
}

// shortcut: a helper must be observed before reparenting; use a delegated cgroup if faster detach leaks appear.
export function descendants(snapshot, pid, known = new Map()) {
  const recycled = snapshot.some(p => p.pid === pid && known.has(pid) && known.get(pid) !== p.birth);
  const owned = new Map(snapshot.filter(p => (!recycled && (p.pid === pid || p.group === pid)) || known.get(p.pid) === p.birth).map(p => [p.pid, p]));
  let size;
  do {
    size = owned.size;
    for (const p of snapshot) if (owned.has(p.parent)) owned.set(p.pid, p);
  } while (size !== owned.size);
  return [...owned.values()];
}
