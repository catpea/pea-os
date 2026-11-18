# Pea OS 0.5.0

The toy grows up. Agent Flow builds teams of agents that plan, write, check
and repair, and every one of its templates runs offline with Pea Mind, a
rule-based thinker inside Pea OS. When a language model is set up, the same
flows use it. One model router stands between apps and every kind of
thinking. Software installs and removes apps, and says plainly which ways of
thinking can run on this device. The desktop's relative positioning, focus
marks and stacking grew up too. Still XML + ESM JavaScript, no npm
dependencies, no code downloaded.

## Start it

As before: `npm start`, then open the printed URL.

## Agent Flow

A board like Pea Flow's, but each node is an agent with an A2A-style card,
and each wire carries a message (an envelope you can watch travel).

| Group | Nodes |
| --- | --- |
| Start and finish | Ask, Result |
| Think | Prompt (a fill-in prompt: `{{names}}` become inputs, `name: example` answer lines become outputs), Agent, in eleven roles (plan, ideate, solve, test, review, repair, verify, summarize, write, classify, chat), with instructions and a choice of thinker |
| Steer | Router (three roads, by words; the others get a skip), Join (waits for all), Check (word counts and must-mention words; sends work back, a few tries at most) |
| Make, offline | Poet, Story shape (Vonnegut's eight shapes, drawn on the node), Song, Novel plan, Family ideas, Word game |

Fifteen templates, none of them frightening:

| Group | Templates |
| --- | --- |
| Make | A poem for you · The shape of a story · Bedtime story and lullaby · Write a song · Plan a novel · Silly sentences · Story starter |
| Family | Family weekend ideas |
| Team | Team solve (plan, ideas a and b, solve, test, review, repair, verify) · Step by step (sequential) · Many helpers at once (parallel) · Try again until it is good (evaluator and optimizer) · Which way? (routing) · Fill in the blanks |

How a run works: a node acts once each wire into it has brought something,
so joins wait; a wire that loops back wakes its node with feedback; a router
skips the roads it did not take and skips pass through, so every branch
ends; a run stops at 200 messages. Results go to Notepad or a sticky note;
the Messages tab keeps every message. Flows are `<agentflow>` XML documents
with the usual Save, Open, undo and recovery, and appear in Documents.

**Answer forms.** A Prompt's answer lines ask the thinker for named answers
in the strongest way it understands: an enforced JSON schema where it has one
(a /v1 server's `response_format`, falling back to lines if the server
refuses; the browser's `responseConstraint`), and otherwise a strict "exactly
these lines, nothing else" contract with your examples, which small models
follow far better than a request for JSON. The reply is read as JSON or as
lines, however it is dressed; a reply out of form is asked for once more.

## One way to think

`os.ai` is a model router with five providers. The **built-in browser AI**
is the browser's own model through the Prompt API (Gemini Nano in Chrome 148
and newer, on capable desktop computers); Software's Install asks the
browser to fetch it. Firefox opposes the Prompt API and Safari has none, so
there they read *Incompatible*. **Pea Mind** is always there.
**Model server** is any /v1 server set up in Agent Chat. **WebLLM** and
**on-device models** are described and never fetched. When agents are left
to choose, the router takes the first ready provider. If that one fails, it
answers with Pea Mind instead and says why, so a flow finishes even when a
server is down. Apps never learn where an answer came from unless they ask.

## Pea Timer

A new app: an interval timer with a pixel hero you design, who does curls,
presses and lateral raises through each work interval. The hero and the
timer core came from Roundhouse. Quick, Classic and Long plans and your own
(**Mine**, set in the **Plan** tool); the time left in the interval and in
the session; a strip of colored segments, one per interval; a sky for each
phase; hearts while you work and confetti at the end. Square-wave cues
count down the last three seconds and mark each phase, and a minimized
timer keeps calling them. Finished workouts raise the hero's level and
unlock looks; skipped work earns none.

**Sound.** Pea OS has a tiny square-wave synth: `os.play` and `app.play`
take `[{ hz, ms }]`, the browser plays them with Web Audio after the first
press or key, and the new `sound` setting (Settings › Look › Sounds, and
settings.xml) silences everything. Platforms may supply `tone(notes)`;
NativeScript does not yet.

## Tool windows

- Docked tools no longer cover one another. Each takes the first free place
  beside its window: down a column on the right, then further right, then
  on the left, and on top of the window's corner only when there is no room
  at all. They keep clear of the map when they can, and opening a second
  tool does not move the first.
- Tools resize by their edges and corners, like windows, with `min-width`,
  `min-height` and `resize="false"` on `<tool>`. They show no grow
  corner, which would cover a palette's last control. A docked tool resized
  from its right or bottom edge stays docked.

## The map

- A minimized window is an empty dotted outline on the map, so it no longer
  looks like a window that is on screen.
- Clicking a window on the map centers the view on it and brings it back if
  it was minimized. Dragging from a window still drags the view.

## Software

A new desktop icon. **Apps**: remove hides an app from the desktop and
Start (its documents stay); install shows it again. Settings, Software,
Documents and About always stay. **Thinking**: each provider with its
status, maker, licence and needs. WebLLM reads *Incompatible: WebLLM
requires WebGPU, which this browser or device does not offer.* Where WebGPU
exists, it reads that the library must be supplied with Pea OS, because Pea
OS never downloads code. The on-device model is *Incompatible* off native
platforms.

## Windows and the desktop

- Tool windows move with their owner during the drag, not after it. During a
  resize, a docked tool keeps to the edge it is docked to, and a floating tool
  keeps its distance from the nearest edge, so neither ends up over the
  larger window.
- **Always on top** and **Always on visible workspace** in the window menu and
  the caption menu. The map is always on top by default; its menu turns that
  off.
- Each sticky note has its own size (**Size 2×–4×** in the note's menu), to
  mark the important ones.
- Focus marks are strict: a dotted ring inside small controls, a frame on
  large ones only after keyboard navigation, and none on surfaces that show
  focus their own way. Pea Flow's board no longer draws a dotted line under
  its toolbox.
- Pea Flow zooms with the mouse wheel about the pointer (50%–300%; Shift and
  the wheel scroll), with **-**, **+** and a percentage button. Node types
  drag from the list onto the board.
- Nodes resize from their bottom-right corner, in Pea Flow and Agent Flow
  alike, and **Default size** puts them back. A wider node shows long port
  names in full; a larger one shows more of what it holds: an agent's whole
  answer with its line breaks, a Display's long text, more Log lines (50 are
  kept) and more Plot points (160). The size is saved with the document.

## Shell consistency

- One caption for everything with a title: the Start menu, the map, the
  desktop overview and sticky notes now wear the theme's window motif
  (stripes, dithered bands or solid), with the close box at the left as on a
  window. The skin's `caption()` draws them all, windows included.
- The Start menu, the map and the overview can be magnified 2×–4× from their
  own context menus, like windows, the menu bar, the taskbar and icons.
  Right-click the Start button or the open Start menu; Start and the overview
  come back at their new size. New `magnify` targets: `start`, `minimap`,
  `overview`.
- Taskbar buttons are flatter and smarter: the Start button is sized to its
  label (it no longer runs past its edge), buttons answer the pointer, the
  window in front is underlined, a minimized window's button is bare, and a
  label that cannot fit gives way to the icon alone. Ordinary buttons shorten
  their labels with an ellipsis instead of spilling.
- Start's tabs are underlined, and its footer shortcuts carry glyphs.
- A new sticky note no longer scrolls the desk or puts windows away. It
  appears in view, in the first clear spot beside windows and icons, or where
  the desk was right-clicked. Revealing a note scrolls only as far as needed,
  and windows step aside only when one would hide it.

## For app makers

- `ui.drag(payload, { label, sprite })`, `<list drag="kind">` and
  `canvas.useDrop({ accepts, drop })`: drag and drop with a ghost.
- `src/ui/graph.js`: `GraphView` (pan, wheel zoom about the pointer, crisp
  magnified drawing), wire curves, and `parseGraph`/`serializeGraph` for
  node-and-wire documents, with optional `w` and `h` per node; `sizeOf`,
  `onGrip`, `drawGrip` and `resizing` give a board resizable nodes. Pea
  Flow and Agent Flow share the parser and the resize gesture.
- `app.ai` / `os.ai`: `complete({ prefer, messages, skill, instructions })`,
  `survey()`, `install(id, on)`. `src/ai/protocol.js`: messages, tasks,
  `asChat`. `src/ai/flow.js`: `AgentRun` with a caller-supplied transport.
- `os.software`: `installed(id)`, `install(id, on)`, `removed` (a signal).
- `app.play(notes)`, `app.frame(fn, { background: true })` and the
  `app.open` signal.
- `files.begin(value, { name })` starts a document from a template.
- Platforms may report `name` and `capabilities: { webgpu }`.

## Not in this release

- **WebLLM is not included.** Pea downloads data where the platform allows
  (models, images, audio, documents) but never code, to keep supply-chain
  attacks out. WebLLM's library is code, so Pea OS describes it and explains
  what it needs but does not fetch it. With a copy supplied with Pea OS, its
  models, being data, could then be downloaded.
- **On-device models** need a NativeScript bridge that is not built.
- **Pea Mind is rules, not a model.** Its poems and stories are often
  charming, but its team answers are formulaic (plans and reviews follow
  templates), and it never understands a request the way a model does.

## Verification for this release

**142 automated tests passed, with zero failures, cancellations or skips.**
Among them: 21 for Pea Mind (deterministic answers, 5/7/5 haiku, story
points matching each shape, every character drawable by the Pea font) and 9
for the agent layer, plus 5 for fill-in prompts and answer forms and the
browser's built-in model (against a stand-in Prompt API). The 9 cover the
protocol; the router, including a /v1
server through `os.request` and fallback to Pea Mind when it fails; strict
`<agentflow>` reading; every template running to its result offline; the
check-and-retry loop; router skips; failed and stopped runs; the board run,
with drag-in from the list; and Software hiding and showing apps. Three more
cover resizable nodes: sizes kept and capped in the XML, and a corner drag in
each board (with undo, and the smallest size held).
`npm run check` passed: 113 files, 15 apps, 5 themes, 60 components, every
app opened under every theme. Agent Flow and Software were rendered with the
headless compositor at pixel size 1 on a 960×540 screen in the Garden and
Midnight themes, mid-run, and inspected.

Tool windows, added afterwards: `npm test` passed 160 of 160, with new tests
for `dock()` (columns, the left side, inside the corner, floating tools and
the map), two Pea Timer tools that never overlap, and resizing a tool. Both
Pea Timer tools were rendered open together at 480×270, 640×360 and 960×540.

The map, added afterwards: `npm test` passed 161 of 161, with a new test for
the dotted outline, a click that restores and centers a minimized window, and
a drag that starts on a window. The map was rendered at pixel size 1 on a
960×540 screen in the Garden, Midnight and Pocket themes.

Pea Timer, added afterwards: `npm test` passed 157 of 157 (6 for the app:
a whole workout, no level for skipped work, the plan steppers and their XML,
the step sizes, the cues and Sounds off, a minimized timer that keeps
calling and a closed one that pauses; plus 9 carried over from Roundhouse
for poses, looks and the timer core). `npm run check` passed: 118 files, 16
apps, 5 themes, 63 components. The app was rendered headless at 480×270 and
at pixel size 1 on 960×540, in each phase, with Animations on and off. The
Web Audio synth has not been heard in a real browser.

Not verified: no real browser, no real model server, no Chrome with the
Prompt API and no WebGPU device was used. The server path was tested against fake answers in the headless
platform. The 0.4 and 0.3 notes below about browser, IME, file-dialog,
network and NativeScript verification still apply.

---

# Pea OS 0.4.0 (earlier release)

This release adds four apps, a narrow network path for them, and a round of
finishing touches to menus, the taskbar, the font and sticky notes. It keeps
the 0.3 structure: XML + ESM JavaScript, no npm dependencies.

## Start it

As before: extract the archive, open a terminal in its folder, run
`npm start` and open the printed URL. Feeds and Agent Chat need that server:
it relays their requests (see *The network* in README.md).

## New apps

| App | What it does |
| --- | --- |
| Pea Records | A card-file database. Browse one record at a time with the book and rail in the status area, list the found set as a table with sortable headings, find with words, `=exact`, `>`, `<` and ranges, and define text, number, date, yes/no, choice and long-text fields. Opens with an example seed catalogue. |
| Pea Flow | A visual language: nodes with ports, wires dragged from outputs to inputs, and objects that visibly travel along the wires when the program runs. Fifteen node types (clock, button, number, text, random, counter, math, compare, toggle, delay, format, display, lamp, log, plot). Programs are XML documents. |
| Pea Feeds | An RSS and Atom reader with feed discovery from web pages, unread marks, OPML import/export, and a bundled offline feed. |
| Agent Chat | Chat with any `/v1/chat/completions` server (Ollama, llama.cpp, LM Studio, vLLM or hosted). Streaming replies, Stop, a model list from the server, and optional Pea tools: open apps, write sticky notes, list apps/notes/documents, read the clock. |

Records and Flow documents use the shared document lifecycle (Save, Save As,
Open, Import, Export, undo, recovery) and appear in Documents with a summary.

## Finishing touches

- Menu items carry small glyphs that stay dim until pointed at, and show their
  keyboard shortcuts. A **Window** menu acts on the window in front (its items
  are disabled when there is none). **Apps** is grouped into Create, Organize,
  Connect, Play, Utilities and System, each app with a mini icon.
- Start shows a one-line summary under each app and pins the new apps.
- Task buttons show the app's mini icon.
- The pixel font gained curly quotes, en and em dashes, °, €, £, ⚠ and common
  accented letters, so feed and chat text reads as written.
- Sticky notes resize from their corner, show their first line as a title,
  roll up with a double tap on the header, duplicate, take turns with colors,
  and record when they were last changed. Color chips appear on the header
  while it is pointed at or the note is being written in. The manager
  searches notes and shows each one's color, desktop and age. Older note
  files import unchanged.
- `<field secret="true">` masks its text (used for the API key).

## The network

The browser cannot read most feeds or local model servers directly, so
`pos serve` relays requests at `/__pos/relay`. It answers only this
computer and only Pea OS pages opened through `127.0.0.1` or `localhost`,
allows http(s) GET and POST, strips cookies, limits sizes and time, aborts
the upstream request when the page stops listening, and never logs what
passes through. Nothing is fetched in the background.

The Agent Chat setup, including an API key, and the conversation are stored
in this browser's local storage for this address.

## Verification for this release

Run `npm test` and `npm run check`; the results at release time are recorded
below.

**101 automated tests passed, with zero failures, cancellations or skips**
(82 from 0.3, adjusted for thirteen apps, plus 19 new). `npm run check`
passed: 98 files, 13 apps, 5 themes, 51 components, every app opened under
every theme. `pos serve` was also started for real and its relay exercised
with curl against a local fake model server: a JSON model list, a streamed
reply passed through as it was written, and a request with a foreign `Host`
refused with 403. New windows and menus were rendered with the headless
compositor and inspected at 320×200 through 960×540, at pixel size 1, in the
Garden, Midnight, Arcade, Classic and Pocket themes.

Not verified: no real browser, real feed or real model server was used while
building 0.4. The relay was tested against local HTTP servers; feeds and chat
against fake network answers in the headless platform. The 0.3 notes below
about browser, IME, file-dialog and NativeScript verification still apply.

---

# Pea OS 0.3.0 (earlier release)

This release completes a focused desktop upgrade: useful writing tools,
conventional document saving, reusable controls and predictable navigation.
The existing XML + ESM JavaScript structure remains, with no npm dependencies.

### Start the downloaded program

Extract the complete archive, open a terminal in its `pea-os-0.3.0` folder,
then run:

```sh
npm start
```

Use Node.js 22.2 or newer; this release was checked with Node 24.22.1.
The PNG tooling uses Node's built-in
[CRC32 API](https://nodejs.org/api/zlib.html#zlibcrc32data-value).
No `npm install` is needed. Open the HTTP URL printed by the command.
The included Pixi 8.5.2 build lets the local browser version start offline.

Keep using the same browser profile, host and port to find your saved data.
The default port is 8080. If it is occupied by another application, the server
reports the conflict instead of silently moving your workspace to another
browser storage origin. Choose another port explicitly if needed:

```sh
node bin/pos.mjs serve --port 8081
```

### What is included

| Area | Result |
| --- | --- |
| Sticky Notes | Editable desktop notes; five colors; drag; per-desktop location; hide, reveal, archive and restore; validated JSON import/export. Failed persistence keeps the current note available in memory. |
| Notepad | Caret and selection, text undo/redo, find and match navigation, line/column status, plain-text import/export. |
| Documents | Search, type filter, previews, open, rename, export, delete and create. Compact screens have an explicit Preview/Back control. |
| Saving | New, Open, Save, Save As, Import and Export; document name and unsaved marker in the caption; separate recovery drafts; rejection of stale saves. |
| Paint | A fixed-size image inside a scrolling viewport; pencil, eraser, fill, line, rectangle and eyedropper; undo/redo; editable XML and PNG export. |
| Cards | Shared file lifecycle, undo/redo, card selector, editable text inspector, and migration of the original autosave with its backup retained. |
| Start | Search apps and document names; Pinned, All apps and Recent tabs; pin controls and useful shortcuts. |
| Desktop | Mini-map, desktop overview, window switching, taskbar overflow and keyboard-operated scrolling menus. |
| UI controls | Text field, text area, list, select, scroll, split, tabs, wrapping toolbars, focus traversal, disabled states and responsive modal dialogs. |

Save and Save As store named documents in Pea. Export writes an external
copy; it does not change the document that Save updates. Closing an app
window still hides the app rather than discarding its working document.
Each editor has one active document and one recovery draft. Recovery is
best effort; export valuable work for a portable backup.

Notes are bounded to 80 records including their archive, with 8,192
characters per note. Nothing is silently evicted. Empty archive asks before
permanent deletion. A note's close box hides it; archiving is a separate
action. New note and Reveal expose the desktop; Show desktop can restore
the previously visible application windows.

### Resizing and panning rules

- The saved world coordinates, normal window rectangle, tile mode, pan and
  document dimensions are independent of the screen presentation.
- Small screens present the active app maximized; returning to a larger
  screen restores the existing arrangement.
- Requested pixel size is capped if needed to preserve a usable logical
  viewport. Requested magnifications remain remembered for their pixel size.
- Toolbars wrap, long panels scroll, menus overflow and dialogs fit inside
  the viewport. Scrolling clips rendering and pointer hit-testing together.
- The mini-map includes negative/off-screen objects and the current viewport.
  Clicking or dragging changes the camera without moving those objects.
  It sits below app windows so it cannot steal input from their controls.

### Verification for this release

**82 automated tests passed, with zero failures, cancellations or skips.**
`npm run check` passed for all nine apps under all five themes, including the
manifest/file inventory. Tests cover the real headless kernel, app workflows,
input and rendering logic, document failures, recovery, Save As, concurrent
save conflicts, note imports, focus, clipping and compact layouts.

The responsive regression changes screen dimensions from 160×200 and
200×160 up to 1280×720; device density 1, 1.25, 2 and 2.6; automatic and manual
pixel sizes; and the on-screen keyboard. It checks that document contents,
camera position, normal geometry, note coordinates and unfinished modal
input remain intact. Additional headless screenshots were visually reviewed.

The upgrade has **not yet been exercised in a real browser**. The available
Chromium process could not launch because this environment denied its
process socket. Headless tests do not verify WebGL, actual IME/clipboard,
touch, browser file dialogs or native IndexedDB behavior. IndexedDB tests
exercise transaction sequencing and failure handling at the adapter boundary.

The existing NativeScript adapter remains unverified on devices and still
needs native text/composition, file sharing/picking and PNG-export adapters.
The bitmap font retains unsupported Unicode text in documents but displays
fallback glyphs. The controls provide keyboard focus behavior, not a full
screen-reader accessibility tree.

Run the included verification yourself with:

```sh
npm test
npm run check
```

README.md covers user workflows; ARCHITECTURE.md documents the contracts
and module boundaries. TODO.xml records platform work still outstanding.
