/**
 * Reads manifest.xml, the authoritative map of the application: entry points,
 * source components and resources, each with its location.
 */

export const RESOURCE_KINDS = ['font', 'sprites', 'theme', 'desktop', 'app', 'data'];

export function readManifest(node) {
  if (node.name !== 'application') node.fail('must be <application>');
  node.expect({ attrs: ['version', 'id', 'name', 'short', 'release'], children: ['entries', 'components', 'resources', 'documents'] });

  const list = (group, child, attrs, required) => {
    const parent = node.child(group);
    if (!parent) node.fail(`needs a <${group}> section`);
    parent.expect({ children: [child].flat() });
    return parent.children.map(item => {
      item.expect({ attrs });
      for (const name of required) item.need(name);
      return item;
    });
  };

  const entries = list('entries', 'entry', ['platform', 'src', 'summary'], ['platform', 'src']);
  const components = list('components', 'component', ['id', 'src', 'summary'], ['id', 'src']);
  const documents = list('documents', 'document', ['src', 'summary'], ['src']);
  const resources = list('resources', RESOURCE_KINDS, ['id', 'src', 'script'], ['id', 'src']);

  const seen = new Set();
  for (const item of [...components, ...resources]) {
    const key = `${item.name}:${item.attr('id')}`;
    if (seen.has(key)) item.fail(`id="${item.attr('id')}" is listed twice`);
    seen.add(key);
    if (item.has('script') && item.name !== 'app') item.fail('only <app> may have a script');
  }
  if (resources.filter(item => item.name === 'desktop').length !== 1) node.fail('needs exactly one <desktop> resource');
  if (!resources.some(item => item.name === 'font')) node.fail('needs at least one <font> resource');
  if (!resources.some(item => item.name === 'theme')) node.fail('needs at least one <theme> resource');

  return {
    id: node.need('id'),
    name: node.need('name'),
    short: node.attr('short', node.need('id')),
    release: node.need('release'),
    entries: entries.map(item => ({ platform: item.attr('platform'), src: item.attr('src') })),
    components: components.map(item => ({ id: item.attr('id'), src: item.attr('src') })),
    documents: documents.map(item => ({ src: item.attr('src') })),
    resources: resources.map(item => ({ kind: item.name, id: item.attr('id'), src: item.attr('src'), script: item.attr('script') }))
  };
}

/** Every file the manifest names, for keeping it in sync with the tree. */
export function manifestFiles(manifest) {
  return [
    ...manifest.entries.map(entry => entry.src),
    ...manifest.components.map(component => component.src),
    ...manifest.documents.map(document => document.src),
    ...manifest.resources.flatMap(resource => [resource.src, resource.script].filter(Boolean))
  ];
}
