import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseXml } from '../src/core/xml.js';
import { readManifest } from '../src/os/manifest.js';

/** The project root: the folder that holds manifest.xml. */
export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[/\\]$/, '');

export async function readXml(root, path) {
  return parseXml(await readFile(join(root, path), 'utf8'), path);
}

export async function loadManifest(root = ROOT) {
  return readManifest(await readXml(root, 'manifest.xml'));
}

/** Every file below `folder`, as forward-slash paths relative to `root`. */
export async function walk(root, folder) {
  const found = [];
  for (const entry of await readdir(join(root, folder), { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) found.push(...await walk(root, path));
    else found.push(relative(root, join(root, path)).split(sep).join('/'));
  }
  return found.sort();
}

/** A usage problem: reported without a stack trace, with exit code 2. */
export class UsageError extends Error {}
