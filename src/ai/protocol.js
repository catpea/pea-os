/**
 * The Pea agent protocol: how agents, whether language models or rule-based
 * ones, talk to each other. It borrows its shape from A2A (agent-to-agent):
 *
 *   AgentCard  { name, description, kind: 'llm' | 'gofai' | 'io', skills: [{ id, name }] }
 *   Message    { id, from, to, role: 'user' | 'agent', parts, task, at }
 *   Part       { kind: 'text', text } | { kind: 'data', data }
 *   Task       { id, state, history: [Message], artifacts: [{ name, parts }] }
 *
 * A task moves through the states below. Everything is plain data, so a
 * message can be shown, logged, saved or sent over a wire to another program
 * without translation.
 */

export const TASK_STATES = ['submitted', 'working', 'input-required', 'completed', 'failed', 'canceled'];

let serial = 0;
const id = prefix => `${prefix}-${Date.now().toString(36)}-${(++serial).toString(36)}`;

/** A message with one text part and, optionally, one data part. */
export function message({ from = 'user', to = '', role = 'agent', text = '', data, task = '' } = {}) {
  const parts = [{ kind: 'text', text: String(text) }];
  if (data !== undefined) parts.push({ kind: 'data', data });
  return Object.freeze({ id: id('msg'), from, to, role, parts: Object.freeze(parts), task, at: Date.now() });
}

/** The text of a message: its text parts, joined. */
export function textOf(msg) {
  return (msg?.parts ?? []).filter(part => part.kind === 'text').map(part => part.text).join('\n').trim();
}

/** The first data part of a message, or undefined. */
export function dataOf(msg) {
  return msg?.parts?.find(part => part.kind === 'data')?.data;
}

export function createTask(title = '') {
  return { id: id('task'), title, state: 'submitted', history: [], artifacts: [] };
}

/** Moves a task to another state; states only go forward from finished ones on purpose. */
export function setState(task, state) {
  if (!TASK_STATES.includes(state)) throw new Error(`"${state}" is not a task state. States: ${TASK_STATES.join(', ')}`);
  task.state = state;
  return task;
}

/** Turns a chain of messages into the role/content list chat models expect. */
export function asChat(system, inputs) {
  const content = inputs.map(msg => (inputs.length > 1 ? `From ${msg.from}:\n${textOf(msg)}` : textOf(msg))).join('\n\n');
  return [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: content || '(nothing yet)' }];
}
