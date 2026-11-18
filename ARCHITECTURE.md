# Pea OS architecture

## Layers

```
platform   browser | nativescript | headless      supplies PIXI, a canvas, files, storage, input
   os      kernel, desktop model, shell, taskbar, apps   boots from manifest.xml
   ui      widgets, layout, the XML view language
   gfx     bitmap, font, sprites, theme, skin     paints pixels; stage.js alone talks to Pixi
   core    reactive, xml                          no dependencies at all
```

A layer imports only from layers below it. Nothing below `platform` touches a
DOM, a file system or a global, so the same modules run in a browser, in
NativeScript and in Node.

## Contracts

**State is pushed.** A `Signal` owns a value. `combineLatest` derives a
read-only signal from explicit sources. Derived values settle in depth order
before any subscriber runs, so a subscriber never sees a half-updated graph;
`batch` coalesces writes; a write made by a subscriber starts a new wave and
never alters the `(value, previous)` pair already being delivered. Nothing
polls and nothing diffs.

**Lifetimes are owned.** Every subscription, listener, timer, derived edge and
texture belongs to a `DisposableScope`. Disposal is last-in first-out,
idempotent, and continues past a failing cleanup. An app has one scope; a
widget has one; a wallpaper's animation has a child scope that is replaced
when the theme or the screen size changes.

**Names fail loudly.** `scope.resolve('typo')` throws. So does an unknown XML
tag, attribute, color role, sprite, signal or command. `XmlError` carries the
file and line. `pos check` boots every app under every theme, so these
surface before a browser is ever opened.

**Chrome is painted on demand, not per frame.** A widget repaints its bitmap
only when it is invalidated: its size changed, a signal it watches changed,
or the theme changed. The frame clock exists for motion (tweens, sprites,
games) and for composition. There is no application-wide render call.

**Commands change a model; views follow.** `DesktopModel.state` is an
immutable snapshot: four virtual desktops, each with its windows, their
stacking order and its pan; the desktop on screen; and the icons the user has
placed. `open`, `close`, `activate`, `minimize`, `move`, `resize`, `mode`,
`shade`, `pan`, `desk`, `send`, `peek`, `arrange`, `icon` and `tidy` replace
it. The shell subscribes once and pushes the difference to widgets it
already owns. The taskbar is a second, independent view of the same state.

**Closing hides.** An app instance is created the first time its window opens
and kept until shutdown. Closing or minimizing a window hides it and pauses
its frame callbacks; showing it again shows the same instance with
everything it held. A clock may ask for background frames, which keep
running while the window is minimized and stop only when it is closed.

**A gesture is one transaction.** A window being dragged or resized, an icon
being dragged and a desk being panned all follow the pointer directly and
commit a single command when the gesture ends; a cancelled gesture restores
what the model says. Nothing is stored for positions merely passed through.
The shell decides where a gesture may go (magnets, the reachable caption,
minimum sizes) and what its end means (a move, or a tile).

**Tiles are derived, not stored.** A window has one normal rectangle. A mode
other than `normal` ("max", "left", "top-right", ...) places it against the
screen and leaves that rectangle alone, so restoring needs no second
rectangle, and a tiled window is right on any screen size. Small screens
force `max` in the view without touching the model.

**The world pans; the screen does not.** Normal windows and notes live in
world coordinates that start at the top left of the work area and scroll
with the desktop's pan. Icons, tiled windows, the bars, the keyboard and
menus are placed on the screen; icons keep work-area coordinates, shared by
every desktop, so a pan can move the windows out of the way of the icons. Magnifying the menu bar therefore moves windows down
with the work area instead of covering their captions. With panning off, the
view keeps a strip of every caption reachable instead.

**Tools belong to an owner.** A tool window is stacked directly above its
owner, shows only while the owner shows, and moves when the owner moves. A
tool with no position is docked: the shell derives its place from the
owner's with `dock()`, which gives each docked tool the first free place
beside its owner (columns to the right, then to the left, filled from the
owner's top), clear of the owner's other tools and, where it can be, of the
map on top. Tools are placed in the order they came on screen, so opening a
second tool never moves the first. Only when there is no room beside the
owner does a tool go inside its corner, and even then tools stack rather
than overlap. A tool resizes like any window; resized from its right or
bottom edge it stays docked. The active window is always an app window,
never a tool.

**Relatives follow the gesture, not the commit.** While an owner is dragged or
resized, the shell keeps the gesture's live rectangle (`desktop.follow`) and
places docked tools from it every frame, so they move with the owner instead
of jumping when the gesture ends. A floating tool is anchored to the owner's
nearest edges (`anchor(from, to, rect)`): when a resize commits, it keeps its
distance from the edge it was nearest to, so a growing window pushes it
along rather than sliding under it. A cancelled gesture puts both back.

**Stacking has two flags.** A window can be `top` (drawn after all others;
`state.layers` gives the order) and `all` (carried to whichever desktop is
shown, at the same place on screen). Both belong to the model and its
snapshots; a tool shares its owner's.

**Focus marks are strict.** A widget declares `focusMark`: `ring` for small
controls (a dotted ring inset 2 pixels, inside the control), `frame` for
large ones, drawn only after keyboard navigation (like `:focus-visible`),
and `none` for surfaces that show focus their own way (the taskbar, popups,
the overview, split dividers, which turn the accent color). Marks never sit on
an edge a neighbour shares, so they cannot leak under a docked toolbox.

**Drag and drop carries data.** A source calls `ui.drag(payload, { label,
sprite })` once a press has moved far enough (a `<list drag="kind">` does
this itself); from then on the pointer belongs to the drag and a ghost
follows it. Only a widget that answers `accepts(payload)` is offered
`drop(payload, event)`; `Canvas.useDrop` sets both. Payloads are plain data.

**Services have providers.** What differs from one place Pea OS runs to
the next is a service with providers (`src/os/providers.js` lists them and
their contracts): files, sound, video tools, the internet, a schedule,
thinking, and the Pea server. A provider is `{ id, title, kind, about,
status(), requires, ...the service's methods }`; `status()` says in words
whether it works here, and `requires` names the services it cannot work
without: disk files, ffmpeg and the relay require the Pea server; the model
server requires the internet.

A `ProviderSet` (`src/core/providers.js`) holds one service's providers in
the user's order with the ones turned off. A provider is usable when it is
installed, each service it requires has a usable provider, and its own
status is ok; `find()` returns the first usable one, `route()` falls back to
the one that always stays (memory files, the page schedule, Pea Mind), and
`why()` says in a sentence why nothing gives the service. A
`ProviderRegistry` holds every set, answers their requirements, and checks
once everything is registered that each requirement names a service and
that none goes round in a circle. Resolving is only walking that graph in
the user's order; it never searches, so every answer can be explained, and
the Software window draws it as a tree. Each set keeps `current`, a signal
of the provider that works now; changing a provider refreshes the whole
registry, so a service that depends on it follows.

The platform injects the providers it has (`platform.providers`); Pea OS
adds its built-in ones; the catalog (`res/data/software.xml`) names every
provider Pea knows of, and one the platform lacks is listed by a placeholder
carrying its `absent` reason. So the same files adapt: opened from pos
serve, files go to disk and requests through the relay; on a static web
host the Pea server is missing, everything that requires it steps aside
with that one reason, and files stay in the browser while the page asks
sites directly.

Apps declare services in their XML. `requires="media"` means the app cannot
work without it, so Pea Cut is installed only while something gives video
tools. `uses="network schedule"` means it is better with them: Pea Feeds runs
anywhere and its status line says "Pea Feeds can't reach the internet here.
…" when nothing gives it. A script reaches only what it declared, through
`app.service(name)`: `ready` (a signal), `use()` (the provider, or a
failure in those words) and `why()`. `app.request()` and `app.ai` go
through the same declarations. Apps call `use()` for each piece of work
rather than keeping a provider, so a change in Software takes effect at once.

A player is pushed, not polled: its `state` signal carries a position, the
player clock's time `at` that position, and the status, so a moving
display works the time out on the frame clock instead of asking the player.
`remote` carries previous and next from media keys and lock screens.

**Thinking goes through one router.** `os.ai` is a model router, the
thinking service's `ProviderSet`. A provider
is `{ id, title, kind, status(), complete(request) }`; `status` says in
words why it cannot answer here. Pea Mind (rule-based, `src/ai/gofai.js`) is
always installed; a /v1 server is reached through `os.request`, so each
platform's way of making requests stays behind the platform contract;
the browser's own model comes from `platform.languageModel` (the Prompt
API), and its download is the browser's, started by the user; WebLLM and
on-device models are described from `platform.capabilities` and never
fetched. Android and iOS differences stay inside the device provider.
Apps call `os.ai.complete({ prefer, messages, skill, instructions })` and
never learn where the answer came from, except from `reply.provider`.

**Data may be downloaded; code never.** Models, images, audio and documents
may be fetched where the platform allows, such as the browser fetching its
model when the user presses Install. Code is never fetched at run time and
`package.json` has no dependencies: what runs is what shipped, so a
compromised package or CDN cannot reach Pea OS.

**Named answers are a form, not a parser per app.** A request may carry
`form: [{ name, example }]` (`src/ai/form.js`). Each provider asks in the
strongest way it has: a JSON schema it enforces (`response_format` on a /v1
server, retried with lines if refused; `responseConstraint` in the browser)
or a strict lines contract; Pea Mind fills the form by rules. One reader,
`readForm`, takes JSON or lines back. Prompt nodes name their ports from
their own text, so `parseGraph` accepts ports given as a function of a
node's settings. A node may also carry `w` and `h` once the user resizes
it; a node without them takes its board's own size, so documents stay small
and older ones read unchanged. Each board's `nodeSize` decides the smallest
size (room for the ports) and lays its body out in what the size leaves.

**Agents talk in messages.** `src/ai/protocol.js` follows the shape of A2A:
agent cards, messages made of text and data parts, and tasks that move from
submitted to working to completed, failed or canceled. An agent flow's
runner (`src/ai/flow.js`) knows nothing of the screen: its caller supplies
`send(wire, msg)` and later calls `deliver`, at once in tests or when an
envelope lands on the board. A node acts once each forward wire has brought
something since it last acted; back wires, found by a walk from the start
nodes, wake their node at once; a router answers unchosen roads with a skip
message, and a node whose inputs were all skipped passes the skip on. The
run ends when nothing is thinking and nothing is in flight.

**Magnification is a widget property.** `widget.zoom` scales a widget and
everything inside it by a whole number: its position stays in its parent's
pixels, its size in its own. Hit testing and pointer coordinates divide on
the way down, so nothing inside a magnified window knows. Because the scene
is composed at art-pixel resolution before the upscale, a 2× window is drawn
in exact 2 × 2 blocks. Which things are magnified is a setting, kept per
pixel size: `{ pixel: { target: zoom } }`, where a target is an app's windows,
the menu bar, the taskbar, the icons, the Start menu (`start`), the map
(`minimap`) or the overview (`overview`). A sticky note keeps its own size
per pixel size in its record (`zooms`), so notes are magnified one by one.

**One caption.** Everything with a title draws it with the skin's
`caption()`: windows, dialogs, the Start menu, the map, the overview and
sticky notes (in the note's own paper). The theme's `title` style (stripes,
bands, solid) therefore reads the same across the shell.

**Layout is not document storage.** Persisted state is small versioned JSON:
settings, magnifications, and a layout snapshot. A snapshot is validated in
full before it replaces anything; one that names an unknown window, or
disagrees with itself, is ignored. App content is never part of it. Named documents are files, kept by whichever files provider works
here (`src/os/documents.js`): each one is `documents/<id>.xml`, a
`<document app name format created updated>` holding its `<content>`, and an
app's unsaved draft is `recovery/<app>.xml`. The content is opaque text; each app
owns its parser and serializer. `DocumentController` owns the conventional
file lifecycle, dirty/saving/error state, recovery and bounded undo history.
The old `app.document` key remains only for compatibility and migration.

**Settings are a document too.** `settings.xml` is written from, and
validated against, the same table of options that declares the settings, so
the file, the Settings app and local storage cannot drift apart. Applying
one is all or nothing.

## The pixel pipeline

1. Art is painted into `Bitmap`s: packed premultiplied RGBA, integer
   coordinates, ordered dithering for gradients. Fonts, sprites and chrome
   all draw this way, identically on every platform.
2. Each painted widget owns one buffer texture and one sprite. The scene is a
   tree of Pixi containers measured in art pixels.
3. Every frame the scene is rendered into a framebuffer of exactly the screen
   size in art pixels, and the framebuffer is scaled to the display.

Step 3 is why one art pixel always covers the same number of device pixels,
why moving sprites snap to the art grid, and why "smooth" and "scanlines" are
each a single switch on the final upscale. `Stage` computes the pixel size
from the device size, the device pixel ratio and the user's setting, and never
leaves fewer than 160 art pixels on the short side.

A theme with a `palette` snaps every opaque pixel to that palette as bitmaps
are committed. `<canvas>` content is exempt: an app's own pixels, such as a
picture in Pea Paint, are never rewritten.

## What Pixi is used for

Containers, sprites, rectangular sprite masks, buffer textures, one render
texture and the ticker. That
is the whole surface, and `src/gfx/stage.js` owns texture/render-target creation. The UI's small
`Viewport` helper applies a rectangle sprite mask; the headless compositor
implements the same clip rectangle in software.
Pixi is injected by the platform rather than imported, which is what lets
`cli/headless.mjs` supply a software implementation of the same surface for
tests, validation and screenshots.

Pointer and keyboard input does not go through Pixi. The platform reports raw
events to `stage.pointer` (`{ x, y, button, alt }`) and `stage.keys`; `UI`
hit-tests the widget tree and captures the pointer for the widget that was
pressed.

- A right click asks the widget under it for a menu (`widget.menu(event)`),
  then each ancestor in turn, which is how a click inside an app reaches its
  window's menu.
- A press held still for half a second asks only the pressed widget, so a
  long press opens menus on chrome and never interrupts an app. A `canvas`
  has no menu unless its script opts in with `useMenu(fn)` (Pea Flow does,
  for its board); Paint's canvas never does, so holding still while drawing
  stays drawing.
- The middle button is captured by the nearest widget that claims it; the
  desktop does, to pan from anywhere.
- With no button down, the widget under the pointer may name a cursor shape,
  which is pushed to the platform through one signal.

The on-screen keyboard emits the same `stage.keys` events a hardware
keyboard does. Keys first go through focused controls and modal focus scopes,
then shell shortcuts and the active app. A text field consumes editing keys;
it does not also type into the app behind it. Focus is stored as a widget
identity and survives a layout change. Hidden/disabled controls are skipped.

The browser-only `text-input.js` bridge maintains a native textarea for
composition, clipboard and selection APIs. Each native event enters the
shared event path once. The pixel editor controls navigation across its
rendered lines; the DOM bridge mirrors its selection. NativeScript currently
uses ordinary key-event fallback and still needs its native text adapter.

## The platform contract

```js
boot({
  PIXI, canvas,
  readText(path),            // a file named in manifest.xml
  importModule(path),        // an app script
  storage: { get(key), set(key, text), remove(key) },   // remove is optional
  attach(stage, ui, os),     // wire resize and input; return a disposer
  options: { boot, open, theme, pixel },
  reducedMotion, fullscreen(), report(error),    // optional
  cursor(name),                                  // optional: show a pointer shape
  download(name, text, type),                    // optional: hand the user a file
  pick(accept),                                  // optional: -> Promise<{ name, text } | null>
  exportBitmap(name, bitmap),                    // optional: PNG export at original dimensions
  openUrl(url),                                  // optional: show a web page outside Pea OS
  name, capabilities: { webgpu },                // optional: which platform, and what it can run
  languageModel,                                 // optional: the browser's Prompt API (LanguageModel)
  pickFiles(accept, { multiple }),               // optional: -> Promise<[{ name, type, size, data }]>, any kind of file
  providers: [provider]                          // optional: what this platform gives each service (src/os/providers.js)
})
```

| Platform | server | files | audio | media | network |
| --- | --- | --- | --- | --- | --- |
| Browser (`src/platform/browser.js`) | `served.js` pos serve | `served.js` disk, `files.js` IndexedDB | `audio.js`: media element, Media Session, Web Audio off phones only | `served.js` ffmpeg | `served.js` relay, `network.js` direct |
| NativeScript (`nativescript-media.js`) | none | phone storage | Android MediaPlayer, wake lock, foreground `mediaPlayback` service, MediaSession, audio focus | none yet | `network.js` phone network |
| Headless (`cli/headless.mjs`) | what a test injects | preferences storage | a silent player on the frame clock | what a test injects | a test's `request` |

Every platform also has the built-in providers: preferences storage and
memory for files, the page schedule, and Pea Mind for thinking.

## Disk files and ffmpeg

`pos serve --data DIR` (default `$XDG_DATA_HOME/pea-os`, else
`~/.local/share/pea-os`) keeps files in `DIR/files`, at most one folder deep,
and runs the host's ffmpeg on them:

| Endpoint | Does |
| --- | --- |
| `GET /__pos/services` | `<services><files root/><relay/><media ffmpeg video format/></services>`, or `<media missing="why"/>` |
| `GET /__pos/files?folder=` | `<files><file name size type modified/></files>` |
| `GET /__pos/files/NAME` | the bytes, with one `Range` honoured so players can seek |
| `PUT` / `DELETE /__pos/files/NAME` | write all or nothing (a hidden `.part` file, then a rename), or remove |
| `GET /__pos/media/probe`, `frame`, `peaks` `?name=` | ffprobe facts as XML; one picture as RGBA bytes with `X-Pea-Width`/`X-Pea-Height`; loudness bytes |
| `POST /__pos/media/render` | a `<videoproject>`; answers `progress 0.42` lines, then `done NAME` or `error why` |

They take the relay's checks (loopback client and host, same-origin), so no
other site and no other computer reaches the user's files or programs. Names
pass `fileName()` on both sides. ffmpeg and ffprobe are started without a
shell; the render's arguments come from the project after `parseProject`
has checked it and every source has been probed again, never from text the
page sends. One render runs at a time; closing the request kills ffmpeg and
removes its part file. The identity probe now names the data folder, so a
second `pos serve` reuses a server only for the same project and folder, and
explains when the one on its port is an older Pea OS server.

## The network

`os.request()` accepts only http and https and hands one request to the
internet service. `onText` receives the body as it arrives, which is how chat
replies stream. In a page opened from pos serve, the relay provider posts
the request to `cli/relay.mjs`, because most feeds and model servers send no
CORS headers; elsewhere the direct provider asks the site itself, and when
that fails it says the site may not let pages read it. NativeScript asks
directly; the headless platform has no internet unless a test supplies one.

The relay is a narrow door, not a proxy: loopback clients only, a loopback
`Host` (so DNS rebinding cannot reach it), same-origin `Sec-Fetch-Site` and
`Origin`, http(s) only, GET and POST only, no cookies or hop-by-hop headers,
1 MB requests, 16 MB answers, a two-minute timeout, and an upstream request
that is aborted when the page stops listening. An answer that grows past
16 MB ends in a broken connection, never in a short answer that looks whole.
Bodies are joined as bytes before they are decoded, so a character split
between two chunks arrives intact. The development server's `/__pos/log`,
where a browser page reports its errors to the terminal, takes the same
checks and prints no control characters. It never logs what passes
through, since requests may carry API keys. `X-Pea-Relay: ok` marks an
upstream answer (whatever its status); `X-Pea-Relay: error` marks the relay's
own refusal, with a reason in plain text.

Nothing fetches in the background. Feeds refresh when their window opens and
they are stale, or when asked; chat requests are made when a message is sent.

## Foreign documents

Pea's own XML is read strictly. Documents from elsewhere (web feeds, OPML)
are read by the same parser with `{ foreign: true }`: a doctype is skipped
without expanding anything, and an entity the parser does not know is kept as
written for the reader to decode. Readers of foreign documents look at local
names (`content:encoded` is `encoded`) and ignore what they do not use.

A node's `text` is all of its own text in order; its `tail` is the text that
follows it inside its parent. Together they keep mixed content in order, which
is how Atom's `type="xhtml"` content is read. Line numbers are counted forward
as the parser goes, so a large document parses in time proportional to its
length.

## The XML languages

| Document | Root | Read by |
| --- | --- | --- |
| `manifest.xml` | `<application>` | `src/os/manifest.js` |
| `res/desktop.xml` | `<desktop>`: menus, launcher, context menus, icons | `src/os/desktop.js` |
| `res/apps/*.xml` | `<app>` with `<state>`, `<view>` and `<tool>` | `src/os/app.js`, `src/ui/markup.js` |
| `settings.xml` | `<settings>` | `src/os/settings.js` |
| `res/stacks/*.xml` | `<stack>` of `<card>` | `res/apps/cards.js` |
| Records documents, `res/data/seeds.xml` | `<database>` of `<field>` and `<record>` | `res/apps/records.js` |
| Flow programs | `<flow>` of `<node>` (with `<set>`) and `<wire>` | `res/apps/flow.js` |
| Feed subscriptions | OPML `<opml>` (foreign) | `res/apps/feeds.js` |
| Web feeds, `res/data/pea-news.xml` | RSS 2.0, RSS 1.0 or Atom (foreign) | `res/apps/feeds.js` |
| `res/themes/*.xml` | `<theme>` | `src/gfx/theme.js` |
| `res/sprites/*.xml` | `<sprites>` | `src/gfx/sprites.js` |
| `res/fonts/*.xml` | `<font>` | `src/gfx/font.js` |
| `cli/commands.xml` | `<cli>` | `cli/main.mjs` |
| `res/data/software.xml` | `<software>` of `<keep>` and `<provider>` | `src/os/software.js`, `src/os/providers.js` |
| Pea Cut projects | `<videoproject>` of `<source>`, `<clip>`, `<video>` and `<audio>` | `src/os/video-project.js` (Pea Cut and `cli/media.mjs`) |
| Jukebox playlists | XSPF `<playlist>` (foreign) | `res/apps/music.js` |

All are read by the one parser in `src/core/xml.js`, which needs no DOM.
Each reader calls `node.expect(...)` with the attributes and children it
allows; anything else is an error.

In a view, `{name}` binds to a declared signal and `{os.name}` to a system
signal. An attribute that is exactly one binding is two-way on controls that
edit a value (`check`, `slider`, `choice`, `field`, `textarea`, `list`, `select`, `tabs`). `action="name"` or
`action="name:argument"` runs an app command, or a system command.

System commands: `launch:app`, `close`, `set:signal=value`, `toggle:signal`,
`fullscreen`, `window:verb` (open, close, minimize, maximize, restore, shade,
left, right, here, top, all), `tool:app.tool`, `magnify:target=N`, `desk:N|next|previous`,
`send:N`, `arrange:gather|cascade|icons|home`, `show-desktop`,
`save-settings`, `load-settings`, `start`, `overview`, `switcher`, `new-note`,
`notes:show|restore|export`, `file:new|open|open-dialog|save|save-as|import|export|undo|redo`. A command is checked when the XML that
names it is read, and again when it runs. `window` and `send` act on the
window a context menu was opened on, or on the active window.

System signals: `theme`, `themes`, `pixel`, `pixels`, `smooth`, `scanlines`,
`motion`, `sound`, `taskbar`, `panning`, `minimap`, `minimap-top`, `snap`, `magnets`, `labels`, `grid` (all
remembered), `magnify`, `zooms` (the magnifications at the current pixel
size), `pan-mode`, `keys`, `desk`, `clock`, `release`, `screen`.

## Verification

- `npm test` exercises the real kernel, app and widget code through pointer
  and key events. The suite covers the original desktop operations and new
  document workflows, failure preservation, recovery, Save As, stale-save
  conflicts, note import/archive, Start, mini-map projection, focus scopes,
  clipped scrolling and small dialogs. 0.4 adds the relay (validation,
  refusals, status and streaming through a real local HTTP server), feed
  parsing and the reader against a fake network, chat streaming, tool calls
  and error text, Records paging/find/sort/undo/field changes, Flow parsing,
  running, wiring by drag and undo, menu icons and grouping, and note
  resizing, rolling up and duplication.
- `npm run check` verifies the manifest against the complete file tree and
  opens every app under every theme. There are twenty-three apps and ten themes.
- `pos shot` uses the software compositor to render the same widget trees;
  the 0.3 release's small/large layouts were visually inspected that way.
  Pixel-size and viewport changes are checked against persistent geometry
  and document contents.
- IndexedDB boundary tests separate request success from transaction commit
  in the browser files provider. These are API boundary tests, not a claim
  that a real browser's storage implementation was exercised. Stale saves
  are refused by the document store, which compares a document's saved time
  before writing; two tabs saving the same document at the same instant are
  not serialized against each other.
- Provider resolution is tested on its own (requirements, circles, the
  sentence when nothing gives a service) and through the kernel: a static
  host where everything that requires the Pea server steps aside, apps that
  reach only declared services, the Software tree, documents as XML files
  in preferences storage across a restart, the page schedule, and the relay
  and direct internet providers against local servers.
- The relay was exercised only against local HTTP servers in tests; no
  real feed or model server was contacted while building 0.4.
- Disk files and ffmpeg are tested through a real `pos serve` handler and
  the host's ffmpeg 7.1 (probe, frames, peaks, a render of a reordered and
  mixed timeline, a stopped render); those tests are skipped where ffmpeg is
  missing. The browser audio provider is tested against a stand-in media
  element and Media Session; the Android player and phone storage are
  written to Android's APIs and have not run on a device.
- Real-browser verification for this upgrade remains outstanding. The local
  Chromium runtime could not launch because this execution environment
  denied its process socket. The headless results do not exercise WebGL,
  real IME/clipboard behavior or native file dialogs.
- The original 0.2 documentation records earlier Firefox/WebGL checks. They
  do not establish that the new 0.3 browser paths have passed those checks.
  Chromium, Safari, touch devices and NativeScript device runs remain a
  separate platform verification task.

## Documents and recovery

A stored document is `{version, kind, id, appId, name, format, content,
createdAt, updatedAt}`. Recovery drafts have their own IDs and include a saved
baseline; they never overwrite a named document. The controller serializes
commands, validates before installing imported data, and records edits made
while a save is in flight as still dirty. File operations can be cancelled
without replacing work. Undo is bounded by count and an approximate memory
budget; browser textarea history does not compete with document undo.

Browser writes resolve only when an IndexedDB transaction completes. Updating
an existing document compares its saved revision inside that same read/write
transaction. If it changed elsewhere, the save fails and the local working
copy remains open. A metadata-only rename can refresh safely when saved
content still matches. This is local conflict detection, not collaboration
or cloud sync. Recovery is debounced and best effort; exported files remain
the portable backup.

Sticky notes are separate, bounded desktop records. Note geometry uses world
coordinates and an explicit desktop number; changing the viewport does not
rewrite it. Archive and hide are different actions. Import validates every
record before merging and assigns fresh IDs on collisions. Storage failure
keeps the latest in-memory notes and surfaces an error. Reaching the note
limit never silently discards an archived note.

## Responsive presentation

Screen size is device pixels divided by the chosen effective pixel factor.
World coordinates, normal window bounds, document pixel sizes and the camera
are persisted independently. Compact presentation (less than 340×230 in
either dimension) uses one active maximized window without mutating its
normal rectangle or tile mode. Shell magnification may be capped in the view
to keep controls reachable; the requested magnification remains remembered.

Toolbars can opt into `row wrap="true"`; defaults keep the original layout
contract. `scroll` measures one child, clips both rendering and pointer
hit-testing, and exposes keyboard, wheel and scrollbar navigation. `tabs`
wraps headers; `split` retains its ratio and can show one pane on a narrow
layout. Modal dialogs stay inside the viewport, wrap actions and scroll long
bodies. App layouts may hide a secondary preview behind an explicit toggle.

The mini-map projects the union of the viewport and world objects, including
negative and off-screen coordinates. Dragging freezes that projection until
the gesture ends, so the target does not move under the pointer. The camera
changes while document and object coordinates stay intact. It is anchored
to the screen and placed below app windows to avoid intercepting their input.
A minimized window is an empty dotted outline, drawn over the open ones, in
ink or the wallpaper label color, whichever stands out from the map's ground.
A press on a window is a click until the pointer travels 3 px: the click
restores and activates the frontmost window under it and glides the camera to
center it (`desktop.showWindow`); travel turns it into an ordinary drag.

## Motion

Decorative motion (the boot sequence, zooming outlines, sliding between
desktops, gliding to a window, drifting clouds, the scrolling grid, twinkling
stars, the screen-saver scenes, the dissolve between cards, marching selection
dots) stops when the `motion` setting is off: the same things happen, at once.
It starts off when the platform reports a reduced-motion preference.

A wallpaper's movers live in a child scope of the wallpaper, replaced when the
theme, the motion setting or the screen size changes. The screen-saver scenes
make every sprite and texture they need when they start (fish, sparks, stars,
raindrops, wingbeats) and reuse them, so a scene left running allocates
nothing per frame; a sprite changes picture by swapping to another texture
the scene already owns (`wallpaper.retexture`).
