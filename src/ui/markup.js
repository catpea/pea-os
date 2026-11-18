import { combineLatest } from '../core/reactive.js';
import { XmlError } from '../core/xml.js';
import { parseColor } from '../gfx/color.js';
import { ROLES } from '../gfx/theme.js';
import { Row, Column, Grid, Panel, Spacer } from './layout.js';
import { Label, Button, Check, Slider, Choice, Image, Canvas } from './controls.js';
import { Field, TextArea } from './fields.js';
import { List, Select } from './lists.js';
import { Scroll, Split, Tabs, Tab } from './containers.js';

/**
 * The XML view language.
 *
 *   <column padding="6" gap="4">
 *     <label text="Score: {score}"/>
 *     <check text="Smooth" value="{os.smooth}"/>
 *     <button text="Play" action="start"/>
 *   </column>
 *
 * "{name}" binds to a Signal the context has declared. An attribute that is
 * exactly one binding is two-way where the widget edits a value. Unknown tags,
 * attributes, signal names and colors are errors, reported at their XML line.
 */

export const TAGS = {
  row: Row,
  column: Column,
  grid: Grid,
  panel: Panel,
  spacer: Spacer,
  label: Label,
  button: Button,
  check: Check,
  slider: Slider,
  choice: Choice,
  image: Image,
  canvas: Canvas,
  field: Field,
  textarea: TextArea,
  list: List,
  select: Select,
  scroll: Scroll,
  split: Split,
  tabs: Tabs,
  tab: Tab
};

const BINDING = /\{([\w.-]+)\}/g;
const ONLY_BINDING = /^\{([\w.-]+)\}$/;

/** "true", "12" and "auto" become true, 12 and "auto". */
export function parseValue(text) {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : text;
}

/** "name" or "name:argument". */
export function parseAction(action) {
  const split = action.indexOf(':');
  return split < 0 ? { name: action, arg: undefined } : { name: action.slice(0, split), arg: action.slice(split + 1) };
}

function convert(node, name, raw, type, ctx) {
  const resolve = signal => {
    try {
      return ctx.resolve(signal);
    } catch (error) {
      return node.fail(`${name}="${raw}": ${error.message}`);
    }
  };
  const literal = () => {
    if (raw.includes('{')) node.fail(`${name}="${raw}" cannot be bound to a signal`);
    return raw;
  };
  const only = ONLY_BINDING.exec(raw)?.[1];

  switch (type) {
    case 'number':
      literal();
      return node.num(name);
    case 'boolean':
      literal();
      return node.flag(name);
    case 'string':
    case 'action':
      return literal();
    case 'color':
      literal();
      if (raw.startsWith('#')) {
        try {
          parseColor(raw);
        } catch (error) {
          node.fail(error.message);
        }
      } else if (!(raw in ROLES)) {
        node.fail(`${name}="${raw}" is neither a #color nor a theme role (${Object.keys(ROLES).join(', ')})`);
      }
      return raw;
    case 'list':
      if (!only) node.fail(`${name}="${raw}" must be a single binding such as "{items}"`);
      return resolve(only);
    case 'model':
      return only ? resolve(only) : parseValue(literal());
    case 'text': {
      if (only) return resolve(only);
      const names = [...raw.matchAll(BINDING)].map(match => match[1]);
      if (!names.length) return raw;
      const sources = names.map(resolve);
      return combineLatest(sources, (...values) => {
        let i = 0;
        return raw.replace(BINDING, () => String(values[i++] ?? ''));
      }, { scope: ctx.scope });
    }
    default:
      throw new Error(`Unknown attribute type "${type}"`);
  }
}

/**
 * Builds the widget tree for a view node.
 * ctx: { resolve(name) -> Signal, run(action, widget), scope, refs, actions }
 */
export function build(ui, node, ctx) {
  const Type = TAGS[node.name];
  if (!Type) node.fail(`is not a widget. Widgets: ${Object.keys(TAGS).map(tag => `<${tag}>`).join(', ')}`);

  const props = {};
  for (const [name, raw] of Object.entries(node.attrs)) {
    const type = Type.attrs[name];
    if (!type) node.fail(`has an unknown attribute "${name}". Allowed: ${Object.keys(Type.attrs).join(', ')}`);
    props[name] = convert(node, name, raw, type, ctx);
  }

  if ([Choice, List, Select].includes(Type)) {
    node.expect({ attrs: Object.keys(node.attrs), children: ['option'] });
    props.items = node.all('option').map(option => {
      option.expect({ attrs: ['value', 'text', 'sprite', 'detail', 'disabled'] });
      const sprite = option.attr('sprite');
      if (sprite !== undefined && !ui.sprites.has(sprite)) option.fail(`sprite="${sprite}" is not a known sprite`);
      return { value: parseValue(option.need('value')), text: option.attr('text', option.need('value')), sprite, detail: option.attr('detail'), disabled: option.flag('disabled', false) };
    });
    if (props.items.length && props.options) node.fail('takes <option> children or options="{...}", not both');
  } else if (!Type.container && node.children.length) {
    node.children[0].fail(`cannot be nested inside <${node.name}>`);
  }
  if (Type === Scroll && node.children.length !== 1) node.fail('takes exactly one child');
  if (Type === Split && node.children.length !== 2) node.fail('takes exactly two children');
  if (Type === Tabs && (!node.children.length || node.children.some(child => child.name !== 'tab'))) node.fail('takes one or more <tab> children');

  const text = node.text.trim().replace(/\s+/g, ' ');
  if (text) {
    if (Type !== Label || node.has('text')) node.fail('must not contain text');
    props.text = convert(node, 'text', text, 'text', ctx);
  }

  let widget;
  try {
    widget = new Type(ui, props);
  } catch (error) {
    if (error instanceof XmlError) throw error;
    node.fail(error.message);
  }
  widget.context = ctx;

  if (props.id !== undefined) {
    if (Object.hasOwn(ctx.refs, props.id)) node.fail(`id="${props.id}" is already used in this view`);
    ctx.refs[props.id] = widget;
  }
  for (const [name, value] of Object.entries(props)) if (Type.attrs[name] === 'action' && value) ctx.actions.push({ action: value, node });

  if (Type.container) for (const child of node.children) widget.add(build(ui, child, ctx));
  return widget;
}
