import { escapeXml } from '../core/xml.js';

/**
 * settings.xml: every preference Pea OS remembers, as a document a person can
 * read, keep, and carry to another device.
 *
 *   <settings version="1" release="0.2.0">
 *     <set name="theme" value="garden"/>
 *     <set name="pixel" value="1"/>
 *     <magnify pixel="1">                      <!-- zooms that apply at this pixel size -->
 *       <zoom target="menubar" value="2"/>
 *       <zoom target="calc" value="3"/>
 *     </magnify>
 *   </settings>
 *
 * A schema says what may be written:
 *   options: Map(name -> { choices })   choices is a list, or null for a boolean
 *   realms:  the pixel sizes magnification is kept for
 *   targets: what can be magnified
 *   zooms:   the magnifications allowed
 */

/** Whether `value` is a well-formed magnification table: { pixel: { target: zoom } }. */
export function validMagnify(value, { realms, targets, zooms }) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([realm, table]) => (
    realms.map(String).includes(realm) && typeof table === 'object' && table !== null && !Array.isArray(table)
    && Object.entries(table).every(([target, zoom]) => targets.includes(target) && zoom !== 1 && zooms.includes(zoom))
  ));
}

export function writeSettings({ release, values, magnify }) {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', `<settings version="1" release="${escapeXml(release)}">`];
  for (const [name, value] of Object.entries(values)) lines.push(`  <set name="${escapeXml(name)}" value="${escapeXml(value)}"/>`);
  for (const [realm, table] of Object.entries(magnify)) {
    lines.push(`  <magnify pixel="${escapeXml(realm)}">`);
    for (const [target, zoom] of Object.entries(table)) lines.push(`    <zoom target="${escapeXml(target)}" value="${zoom}"/>`);
    lines.push('  </magnify>');
  }
  lines.push('</settings>', '');
  return lines.join('\n');
}

/** Validates a <settings> document against a schema and returns { values, magnify }. Nothing is applied here. */
export function readSettings(node, { options, realms, targets, zooms }) {
  if (node.name !== 'settings') node.fail('must be <settings>');
  node.expect({ attrs: ['version', 'release'], children: ['set', 'magnify'] });
  if (node.need('version') !== '1') node.fail(`version="${node.attr('version')}" is not supported; this release reads version 1`);

  const values = {};
  for (const set of node.all('set')) {
    set.expect({ attrs: ['name', 'value'] });
    const name = set.need('name');
    const raw = set.need('value');
    const option = options.get(name);
    if (!option) set.fail(`name="${name}" is not a setting. Settings: ${[...options.keys()].join(', ')}`);
    if (Object.hasOwn(values, name)) set.fail(`name="${name}" is set twice`);
    if (option.choices) {
      const choice = option.choices.find(candidate => String(candidate) === raw);
      if (choice === undefined) set.fail(`value="${raw}" is not valid for "${name}". Choose one of: ${option.choices.join(', ')}`);
      values[name] = choice;
    } else {
      values[name] = set.flag('value');
    }
  }

  const magnify = {};
  for (const realm of node.all('magnify')) {
    realm.expect({ attrs: ['pixel'], children: ['zoom'] });
    const pixel = realm.need('pixel');
    if (!realms.map(String).includes(pixel)) realm.fail(`pixel="${pixel}" must be one of ${realms.join(', ')}`);
    if (Object.hasOwn(magnify, pixel)) realm.fail(`pixel="${pixel}" appears twice`);
    const table = {};
    for (const zoom of realm.all('zoom')) {
      zoom.expect({ attrs: ['target', 'value'] });
      const target = zoom.need('target');
      const value = zoom.num('value');
      if (!targets.includes(target)) zoom.fail(`target="${target}" cannot be magnified. Targets: ${targets.join(', ')}`);
      if (!zooms.includes(value)) zoom.fail(`value="${zoom.attr('value')}" must be one of ${zooms.join(', ')}`);
      if (Object.hasOwn(table, target)) zoom.fail(`target="${target}" appears twice`);
      if (value !== 1) table[target] = value;
    }
    if (Object.keys(table).length) magnify[pixel] = table;
  }
  return { values, magnify };
}
