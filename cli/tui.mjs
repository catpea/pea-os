import { emitKeypressEvents } from 'node:readline';

/**
 * The interactive menu shown by a bare `pos` in a terminal. Every entry runs
 * the same code as its command-line form.
 */

const ENTRIES = [
  { label: 'Serve Pea OS to a browser', hint: 'pos serve', run: (io, RUN) => RUN.serve({ values: { port: '8080', host: '127.0.0.1' } }, io), holds: true },
  { label: 'Check the project', hint: 'pos check', run: (io, RUN) => RUN.check({}, io) },
  { label: 'List apps', hint: 'pos list apps', run: (io, RUN) => RUN.list({ positionals: ['apps'] }, io) },
  { label: 'List themes', hint: 'pos list themes', run: (io, RUN) => RUN.list({ positionals: ['themes'] }, io) },
  { label: 'Show the default settings', hint: 'pos settings --defaults', run: (io, RUN) => RUN.settings({ values: { defaults: true }, positionals: [] }, io) },
  { label: 'Quit', hint: 'q' }
];

export async function tui(io, RUN) {
  const { stdin, stdout } = io;
  const color = !process.env.NO_COLOR;
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  let selected = 0;

  emitKeypressEvents(stdin);
  const key = () => new Promise(done => stdin.once('keypress', (_, pressed) => done(pressed ?? {})));
  const raw = on => {
    stdin.setRawMode(on);
    if (on) stdin.resume();
    else stdin.pause();
  };

  const draw = () => {
    const lines = [
      '',
      `  ${paint('32;1', '●')} ${paint('1', 'pos')}  Pea OS developer tool`,
      '',
      ...ENTRIES.map((entry, index) => {
        const row = `${index === selected ? '›' : ' '} ${entry.label.padEnd(28)} ${entry.hint}`;
        return `  ${index === selected ? paint('32;1', row) : row}`;
      }),
      '',
      paint('2', '  ↑/↓ move   enter run   q quit'),
      ''
    ];
    stdout.write(`\x1b[2J\x1b[H${lines.join('\n')}`);
  };

  try {
    for (;;) {
      raw(true);
      draw();
      const pressed = await key();
      if (pressed.name === 'up' || pressed.name === 'k') selected = (selected + ENTRIES.length - 1) % ENTRIES.length;
      else if (pressed.name === 'down' || pressed.name === 'j') selected = (selected + 1) % ENTRIES.length;
      else if (pressed.name === 'q' || pressed.name === 'escape' || (pressed.ctrl && pressed.name === 'c')) return 0;
      else if (pressed.name === 'return') {
        const entry = ENTRIES[selected];
        if (!entry.run) return 0;
        raw(false);
        stdout.write(`\x1b[2J\x1b[H\n  ${paint('1', entry.hint)}\n\n`);
        if (entry.holds) stdout.write(paint('2', '  Press Ctrl+C to stop the server and return.\n\n'));
        try {
          await entry.run(io, RUN);
        } catch (error) {
          io.stderr.write(`pos: ${error.message}\n`);
        }
        raw(true);
        stdout.write(paint('2', '\n  Press any key to return to the menu.'));
        await key();
      }
    }
  } finally {
    raw(false);
    stdout.write('\n');
  }
}
