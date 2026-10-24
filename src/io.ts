import { readFile, writeFile, mkdir, rename, unlink, open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path: string): Promise<unknown> {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text.replace(/^\uFEFF/, '')); }
  catch { throw new Error(`无效 JSON: ${path}`); }
}

export async function writeNewJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
}

// A lock protects local journal updates only; it is not an IDE edit lock.
export async function updateJson<T>(path: string, transform: (value: unknown) => T): Promise<T> {
  const target = resolve(path);
  const lock = await open(target + '.lock', 'wx').catch(() => {
    throw new Error(`记录正在写入，或上次中断留下锁文件: ${target}.lock`);
  });
  const temporary = target + '.' + randomUUID() + '.tmp';
  try {
    const value = transform(await readJson(target));
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
    return value;
  } finally {
    await unlink(temporary).catch(() => undefined);
    await lock.close();
    await unlink(target + '.lock');
  }
}
