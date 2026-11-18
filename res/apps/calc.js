/** Calculator behavior. The view and its one signal are declared in calc.xml. */

const OPERATORS = {
  '+': (a, b) => a + b,
  '-': (a, b) => a - b,
  '×': (a, b) => a * b,
  '÷': (a, b) => (b === 0 ? NaN : a / b)
};
const KEYBOARD = { '*': '×', '/': '÷', Enter: '=', Backspace: 'back', Escape: 'C', c: 'C' };
const MAX_DIGITS = 9;

export default function calculator(app) {
  const display = app.signal('display');
  let entry = '0';       // what is being typed
  let stored = null;     // the left operand
  let operator = null;
  let fresh = true;      // the next digit starts a new entry

  const format = number => {
    if (!Number.isFinite(number)) return 'Error';
    const text = String(Number(number.toPrecision(MAX_DIGITS)));
    return text.length > MAX_DIGITS + 2 ? number.toExponential(3) : text;
  };
  const show = text => {
    entry = text;
    display.set(text);
  };
  const reset = () => {
    stored = null;
    operator = null;
    fresh = true;
    show('0');
  };
  const compute = () => {
    if (operator === null) return;
    show(format(OPERATORS[operator](stored, Number(entry))));
    operator = null;
    fresh = true;
  };

  function press(key) {
    key = String(key);
    if (entry === 'Error' && key !== 'C') reset();
    if (/^\d$/.test(key)) {
      if (fresh) show(key);
      else if (entry.replace(/\D/g, '').length < MAX_DIGITS) show(entry === '0' ? key : entry + key);
      fresh = false;
    } else if (key === '.') {
      if (fresh) show('0.');
      else if (!entry.includes('.')) show(`${entry}.`);
      fresh = false;
    } else if (key in OPERATORS) {
      if (!fresh) compute();
      stored = Number(entry);
      operator = key;
      fresh = true;
    } else if (key === '=') {
      compute();
    } else if (key === 'C') {
      reset();
    } else if (key === 'back') {
      // "-5" less its last digit is 0, not a lone "-" that the next sum would read as an error.
      if (!fresh) show(/^-?\d?$/.test(entry) ? '0' : entry.slice(0, -1));
    } else if (key === 'sign') {
      if (Number(entry) !== 0) show(entry.startsWith('-') ? entry.slice(1) : `-${entry}`);
    } else if (key === '%') {
      show(format(Number(entry) / 100));
      fresh = true;
    }
  }

  app.command('key', press);
  app.scope.on(app.keys, 'down', ({ key }) => {
    const mapped = KEYBOARD[key] ?? key;
    if (/^[\d.%=+-]$/.test(mapped) || mapped in OPERATORS || ['back', 'C'].includes(mapped)) press(mapped);
  });
}
