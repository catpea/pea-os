import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { manifestFiles } from '../src/os/manifest.js';
import { bootHeadless } from './headless.mjs';
import { loadManifest, readXml, walk } from './project.mjs';

/** Folders whose every file must be named in manifest.xml. */
const TRACKED = ['bin', 'cli', 'src', 'res', 'web'];

/**
 * Validates the whole project and returns { problems, summary }.
 * It boots Pea OS headlessly and starts every app under every theme, so XML
 * typos, unknown signals, missing sprites and unresolved actions all surface.
 */
export async function check(root) {
  const problems = [];
  const attempt = async (what, fn) => {
    try {
      return await fn();
    } catch (error) {
      problems.push(`${what}: ${error.message}`);
      return null;
    }
  };

  const manifest = await attempt('manifest.xml', () => loadManifest(root));
  if (!manifest) return { problems, summary: '' };

  const listed = manifestFiles(manifest);
  for (const file of listed) {
    const info = await stat(join(root, file)).catch(() => null);
    if (!info?.isFile()) problems.push(`manifest.xml: "${file}" is listed but does not exist`);
  }
  const duplicates = listed.filter((file, index) => listed.indexOf(file) !== index);
  for (const file of new Set(duplicates)) problems.push(`manifest.xml: "${file}" is listed more than once`);
  for (const folder of TRACKED) {
    for (const file of await walk(root, folder).catch(() => [])) {
      if (!listed.includes(file)) problems.push(`manifest.xml: "${file}" exists but is not listed`);
    }
  }

  await attempt('package.json', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.version !== manifest.release) throw new Error(`version ${pkg.version} differs from the manifest release ${manifest.release}`);
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      if (pkg[field] && Object.keys(pkg[field]).length) throw new Error(`"${field}" must stay empty`);
    }
  });
  await attempt('cli/commands.xml', () => readXml(root, 'cli/commands.xml'));

  const themes = manifest.resources.filter(item => item.kind === 'theme');
  const apps = manifest.resources.filter(item => item.kind === 'app');
  for (const theme of themes) {
    await attempt(`theme "${theme.id}"`, async () => {
      const session = await bootHeadless({ root, options: { theme: theme.id } });
      try {
        for (const app of apps) session.os.open(app.id);
        await session.frames(30);
        if (session.errors.length) throw session.errors[0];
      } finally {
        session.dispose();
      }
    });
    if (problems.length) break; // one theme's errors would repeat for the others
  }

  return {
    problems,
    summary: `${listed.length} files, ${apps.length} apps, ${themes.length} themes, ${manifest.components.length} components`
  };
}
