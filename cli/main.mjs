import { readFile, writeFile } from 'node:fs/promises';
import { text } from 'node:stream/consumers';
import { parseArgs } from 'node:util';
import { XmlError } from '../src/core/xml.js';
import { check } from './check.mjs';
import { bootHeadless } from './headless.mjs';
import { encodePng } from './png.mjs';
import { loadManifest, readXml, ROOT, UsageError } from './project.mjs';
import { serve } from './serve.mjs';
import { tui } from './tui.mjs';

/**
 * The `pos` command. Exit codes: 0 success, 1 the task failed, 2 bad usage.
 * Results go to stdout, diagnostics to stderr, and nothing ever prompts
 * unless both ends are a terminal and no command was given.
 */

async function loadCommands() {
  const cli = await readXml(ROOT, 'cli/commands.xml');
  cli.expect({ attrs: ['version', 'name', 'summary'], children: ['command'] });
  const commands = cli.all('command').map(command => {
    command.expect({ attrs: ['name', 'summary'], children: ['option', 'argument'] });
    return {
      name: command.need('name'),
      summary: command.need('summary'),
      args: command.all('argument').map(argument => {
        argument.expect({ attrs: ['name', 'summary'] });
        return { name: argument.need('name'), summary: argument.need('summary') };
      }),
      options: command.all('option').map(option => {
        option.expect({ attrs: ['name', 'short', 'value', 'default', 'summary', 'repeat', 'flag'] });
        const flag = option.flag('flag');
        if (flag === option.has('value')) option.fail('needs either value="NAME" or flag="true"');
        return {
          name: option.need('name'),
          short: option.attr('short'),
          value: option.attr('value'),
          fallback: option.attr('default'),
          summary: option.need('summary'),
          repeat: option.flag('repeat'),
          flag
        };
      })
    };
  });
  return { name: cli.need('name'), summary: cli.need('summary'), commands };
}

const table = rows => {
  const width = Math.max(...rows.map(([left]) => left.length));
  return rows.map(([left, right]) => `  ${left.padEnd(width)}   ${right}`).join('\n');
};

const optionLabel = option => `${option.short ? `-${option.short}, ` : '    '}--${option.name}${option.value ? ` ${option.value}` : ''}`;

function help(cli, command) {
  if (!command) {
    return [
      `${cli.name} - ${cli.summary}`,
      '',
      'Usage:',
      table([[cli.name, 'Open the interactive menu (terminals only)'], [`${cli.name} <command> [options]`, 'Run one command and exit']]),
      '',
      'Commands:',
      table(cli.commands.map(item => [item.name, item.summary])),
      '',
      'Options:',
      table([['-h, --help', `Show this help, or a command's with "${cli.name} <command> --help"`], ['-V, --version', 'Print the Pea OS release']]),
      '',
      'Exit codes: 0 success, 1 the task failed, 2 bad usage.',
      ''
    ].join('\n');
  }
  const usage = [cli.name, command.name, command.options.length ? '[options]' : '', ...command.args.map(arg => `[${arg.name}]`)].filter(Boolean).join(' ');
  const rows = [
    ...command.args.map(arg => [arg.name, arg.summary]),
    ...command.options.map(option => [optionLabel(option), option.summary + (option.fallback ? ` (default: ${option.fallback})` : '')]),
    ['-h, --help', 'Show this help']
  ];
  return [`Usage: ${usage}`, '', command.summary, '', 'Options:', table(rows), ''].join('\n');
}

function parse(command, argv) {
  const options = { help: { type: 'boolean', short: 'h' } };
  for (const option of command.options) {
    options[option.name] = { type: option.flag ? 'boolean' : 'string' };
    if (option.short) options[option.name].short = option.short;
    if (option.repeat) options[option.name].multiple = true;
    if (option.fallback !== undefined) options[option.name].default = option.fallback;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error.message);
  }
  if (parsed.positionals.length > command.args.length) {
    throw new UsageError(`Unexpected argument "${parsed.positionals[command.args.length]}"`);
  }
  return parsed;
}

const wholeNumber = (text, name, min) => {
  const value = Number(text);
  if (!/^\d+$/.test(text) || value < min) throw new UsageError(`${name} must be a whole number of at least ${min}, got "${text}"`);
  return value;
};

/** Resolves when the process is asked to stop, and then stops listening, so a later run (from the terminal menu) starts clean. */
const interrupted = () => new Promise(done => {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const stop = () => {
    for (const signal of signals) process.off(signal, stop);
    done();
  };
  for (const signal of signals) process.on(signal, stop);
});

const RUN = {
  async serve({ values }, io) {
    const server = await serve({ root: ROOT, port: wholeNumber(values.port, '--port', 0), host: values.host, data: values.data, stderr: io.stderr });
    io.stdout.write(`${server.url}\n`);
    if (server.reused) return 0;
    await interrupted();
    await server.close();
    return 0;
  },

  async check(_, io) {
    const { problems, summary } = await check(ROOT);
    for (const problem of problems) io.stderr.write(`pos check: ${problem}\n`);
    if (problems.length) return 1;
    io.stdout.write(`ok: ${summary}\n`);
    return 0;
  },

  async list({ positionals: [kind = 'apps'] }, io) {
    const manifest = await loadManifest(ROOT);
    const kinds = { apps: 'app', themes: 'theme', fonts: 'font', sprites: 'sprites' };
    let rows;
    if (kind === 'components') {
      rows = manifest.components.map(component => [component.id, component.src]);
    } else if (kind in kinds) {
      rows = [];
      for (const item of manifest.resources.filter(resource => resource.kind === kinds[kind])) {
        const node = await readXml(ROOT, item.src);
        if (kind === 'sprites') {
          for (const sprite of node.all('sprite')) rows.push([sprite.need('id'), item.src]);
        } else {
          rows.push([item.id, node.attr(kind === 'apps' ? 'title' : 'name', item.id), item.src]);
        }
      }
    } else {
      throw new UsageError(`Cannot list "${kind}". Choose apps, themes, fonts, sprites or components.`);
    }
    io.stdout.write(rows.map(row => `${row.join('\t')}\n`).join(''));
    return 0;
  },

  async shot({ values }, io) {
    const size = /^(\d+)x(\d+)$/.exec(values.size);
    if (!size || Number(size[1]) < 64 || Number(size[2]) < 64) throw new UsageError(`--size must look like 320x200 and be at least 64x64, got "${values.size}"`);
    const frames = wholeNumber(values.frames, '--frames', 1);
    const scale = wholeNumber(values.scale, '--scale', 1);
    const points = (name, button) => (values[name] ?? []).map(tap => {
      const point = /^(\d+),(\d+)$/.exec(tap);
      if (!point) throw new UsageError(`--${name} must look like 12,34, got "${tap}"`);
      return { x: Number(point[1]), y: Number(point[2]), button };
    });
    const taps = [...points('tap', 0), ...points('context', 2)];
    const settings = values.settings ? await readFile(values.settings, 'utf8') : null;
    if (!values.output && io.stdout.isTTY) throw new UsageError('A PNG would garble the terminal. Use --output FILE or redirect stdout.');

    const options = { boot: Boolean(values.boot), open: values.open?.split(',').filter(Boolean) ?? [] };
    if (values.theme) options.theme = values.theme;
    const session = await bootHeadless({ root: ROOT, width: Number(size[1]), height: Number(size[2]), options });
    try {
      if (settings !== null) session.os.applySettings(settings, values.settings);
      await session.frames(frames);
      for (const { x, y, button } of taps) {
        await session.tap(x, y, button);
        await session.frames(20);
      }
      if (session.errors.length) throw session.errors[0];
      const png = encodePng(session.render(), scale);
      if (values.output) await writeFile(values.output, png);
      else io.stdout.write(png);
    } finally {
      session.dispose();
    }
    return 0;
  },

  async settings({ values, positionals: [file] }, io) {
    if (values.defaults && file !== undefined) throw new UsageError('--defaults reads nothing; leave out the file');
    const piped = !values.defaults && (file === '-' || (file === undefined && !io.stdin.isTTY));
    if (!values.defaults && !piped && file === undefined) throw new UsageError('Give a settings.xml file, pipe one in, or pass --defaults.');
    const input = piped ? await text(io.stdin) : values.defaults ? null : await readFile(file, 'utf8');
    const session = await bootHeadless({ root: ROOT });
    try {
      if (input !== null) session.os.applySettings(input, piped ? 'standard input' : file);
      io.stdout.write(session.os.settingsXml());
    } finally {
      session.dispose();
    }
    return 0;
  }
};

export async function main(argv, io = process) {
  try {
    const cli = await loadCommands();
    const [first, ...rest] = argv;

    if (first === undefined) {
      if (io.stdin.isTTY && io.stdout.isTTY) return await tui(io, RUN);
      io.stderr.write(help(cli));
      return 2;
    }
    if (first === '-h' || first === '--help') {
      io.stdout.write(help(cli));
      return 0;
    }
    if (first === '-V' || first === '--version') {
      io.stdout.write(`${(await loadManifest(ROOT)).release}\n`);
      return 0;
    }

    const command = cli.commands.find(item => item.name === first);
    if (!command) throw new UsageError(`Unknown command "${first}". Run "${cli.name} --help".`);
    const parsed = parse(command, rest);
    if (parsed.values.help) {
      io.stdout.write(help(cli, command));
      return 0;
    }
    return await RUN[command.name](parsed, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr.write(`pos: ${error.message}\n`);
      return 2;
    }
    // Problems in project files are expected conditions: report them plainly.
    const expected = error instanceof XmlError || error.code === 'ENOENT';
    io.stderr.write(`pos: ${expected || !process.env.POS_DEBUG ? error.message : error.stack}\n`);
    return 1;
  }
}
