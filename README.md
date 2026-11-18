# Pea OS

**pos** is a small, colorful pixel-art graphical OS. One JavaScript codebase
draws the same desktop in a browser canvas today and is shaped to run on
Android and iOS through NativeScript. Its look comes from the arcade machines
of 1990 and its manners from GEOS: a menu bar, icons on a desk, windows with
pinstriped captions. Under that it is a modern desktop: windows resize, snap
and tile, any of them can be magnified on its own, the desk pans, and there
are four of it.

Everything you see is painted one integer pixel at a time and composited by
[pixi.js](https://pixijs.com). Everything you configure is XML.

## Run it

Node.js 22.2 or newer (tested with Node 24.22.1). There is nothing to install: `package.json` has no
dependencies. The existing pinned Pixi 8.5.2 renderer is included in
`web/vendor`, with its license and integrity hash. The browser version can run
without an internet connection after you extract the complete archive.

```sh
npm start            # serves Pea OS and prints its URL
npm test             # unit and whole-system tests, no browser needed
npm run check        # validates the manifest, every XML file and every app
```

`npm start` uses port 8080. If Pea OS is already being served from this folder,
it prints that URL and exits. If another program owns that port, it reports
the conflict; choose an explicit port with `node bin/pos.mjs serve --port 8081`.
Keep using the same browser profile and URL (including host and port), because
browser document storage belongs to that address. Music, videos and renders
that apps keep on disk go to `~/.local/share/pea-os/files` (or
`$XDG_DATA_HOME/pea-os/files`); `--data DIR` chooses another folder. Pea OS
creates it only when something is first saved there. Open the printed HTTP URL;
double-clicking `web/index.html` is not a supported launch method.

Launch options go in the query string:

```
http://127.0.0.1:8080/web/index.html?theme=arcade&pixel=3&open=paint,calc&boot=0
```

`theme` and `pixel` given this way hold for that visit only. Choices made in
the menus are remembered, and so is the arrangement of windows.

## The `pos` tool

```
pos                      interactive menu (only when run in a terminal)
pos serve [-p PORT] [--host HOST]
pos check
pos list [apps|themes|fonts|sprites|components]
pos shot [-o FILE] [--size WxH] [--theme ID] [--open APPS] [--settings FILE]
         [--tap X,Y] [--context X,Y] [--boot]
pos settings [FILE | --defaults]
```

`pos shot` boots the real OS without a browser and writes a PNG, which makes
theme and app work quick to review:

```sh
node bin/pos.mjs shot --theme night --open paint --size 480x270 -o night.png
node bin/pos.mjs shot --tap 40,5 > menu.png        # tap the Apps menu first
node bin/pos.mjs shot --open calc --context 160,48 -o menu.png   # right-click a caption
```

`pos settings` checks a `settings.xml` against the installed themes and apps
and prints it in canonical form; it reads a file or standard input.

```sh
node bin/pos.mjs settings --defaults > settings.xml
node bin/pos.mjs settings < settings.xml && echo fine
```

Results go to stdout, diagnostics to stderr. Exit codes: 0 success, 1 the task
failed, 2 bad usage.

## Pixel size

Some people want to see every pixel; some would rather not. **Pixels** in the
menu bar (or Settings) sets how many CSS pixels one art pixel covers, from
1 (fine) to 6 (chunky). **Auto** picks a size that gives a comfortable desk on
the current screen. **Smooth pixels** softens the upscale, and **CRT
scanlines** adds the arcade monitor.

The desktop lays itself out for the available art pixels. Below 340 art pixels
of width or 230 of height, it presents one maximized app at a time. This is a
view adjustment: the saved position, size, tile mode, pan and requested
magnification remain intact. Widen the screen again to return to that layout.
Menus and taskbar buttons have overflow controls; long content scrolls.

The requested pixel size is capped when needed to retain at least 160 art
pixels on the short side (unless the physical canvas itself is smaller). The
Settings screen shows the actual logical size and device pixels per art pixel.
Screen density changes affect rendering and input coordinates, not document
dimensions. A painting remains the same number of pixels when its window resizes.

## Magnify

At pixel size 1 the desk is huge and everything on it is small. That is the
point, until one window is too small to use. **Right-click a window** (or
press and hold its caption) and pick **Size 2×**, 3× or 4×: that window, and
only that one, is drawn larger. The calculator can stay tiny while the paint
program fills half the screen.

The menu bar, the taskbar, the icons, the Start menu, the map and the desktop
overview magnify the same way, from their own context menus (right-click the
Start button or the open Start menu, the map or the overview). Menus open at
the menu bar's size.

Each sticky note has a size of its own: right-click a note and pick **Size
2×**, 3× or 4×, so the important ones stand out from the rest.

A magnification belongs to the pixel size it was chosen at. Go from 1 to 4
and everything is back at 1×, because at 4 nothing needed help; go back to 1
and your choices are there again.

## The desktop

| | |
| --- | --- |
| Windows | Drag the caption. Drag any edge or corner, or the grow corner, to resize. The boxes in the caption close, minimize and maximize; a double tap on the caption maximizes too. "Roll up" in the window's menu leaves only the caption. |
| Snapping | Drag a window to the left or right edge for half the screen, into a corner for a quarter, to the top to maximize. A dithered preview shows where it will land. Drag a tiled window away and it takes its old size again, under the pointer. |
| Magnets | While moving or resizing, nearby window edges and matching widths and heights pull gently. A window’s own tools move with it, so they never pull. Hold Alt to place freely. |
| Taskbar | The pea opens searchable Start with pinned apps, all apps and recent documents. Each open window has a button: tap to bring it forward, tap again to minimize. Then the four desktops, pan mode, the on-screen keyboard and "show desktop". |
| Desktops | Four of them. Each has its own windows, its own pan position and its own active window; switching slides. A window's menu can move it to another. |
| Panning | The desk is larger than the screen. Drag with the middle button anywhere, hold Space and drag the empty desk, or turn on pan mode in the taskbar and drag with a finger. Windows and notes move; icons stay on the screen, so panning also clears windows away from them. A task button scrolls to a window that has wandered off; "Gather windows" brings everything home. |
| Mini-map | The screen-anchored map shows windows, notes and the current viewport, including off-screen work. A minimized window shows as an empty dotted outline. Click a window to center it, which also brings it back if it was minimized; click elsewhere to center there, or drag to pan. It stays on top of windows unless its menu says otherwise; Settings can hide it. |
| Overview | Desk › Overview shows the four desktops and their open windows. On small screens it uses a scrolling list. Taskbar overflow and Alt+Tab provide a window switcher. |
| Icons | Tap to open, drag to move. They belong to the screen, not the world: panning and switching desktops leave them where they are. They land on a grid unless "Icon grid" is off; "Tidy icons" lines them up again; labels are optional. |
| Tool windows | Small companions of an app, such as the tool palette of Pea Cards. They float above their owner and hide with it. They sit beside it, never on top of one another or of the map when there is room elsewhere, and opening a second does not move the first. Drag their edges to resize them; one resized from its right or bottom edge stays docked. They move with it while it is dragged, not after, and while it is resized a docked tool keeps to the edge it is docked to, so it never ends up over the larger window. |
| On top, everywhere | **Always on top** (window menu or caption menu) keeps a window above the others. **Always on visible workspace** carries it to whichever desktop you switch to, at the same place on screen. The map is on top by default; its menu turns that off. |
| Context menus | Right-click, or press and hold: a window's caption, a task button, the Start button or menu, an icon, the empty desk, the menu bar, the taskbar, the map, the overview, a note. |
| Menus | Items carry small glyphs, drawn in the text's color and dim until pointed at, and show their keyboard shortcuts. **Window** acts on the window in front; **Apps** lists apps in groups: Create, Organize, Connect, Develop, Play, Utilities, System. |
| Keyboard | The taskbar's keyboard button shows an on-screen keyboard that types wherever a real one would. |

Snapping, magnets, panning, the icon grid and labels, and the taskbar itself
can each be turned off in Settings.

## settings.xml

Everything Pea OS remembers about your preferences is one small document.
**Pea › Save settings.xml** hands it to you as a file; **Load settings.xml**
reads one back. A file with a mistake is refused whole and names the line.

```xml
<settings version="1" release="0.5.0">
  <set name="theme" value="garden"/>
  <set name="pixel" value="1"/>
  <set name="snap" value="true"/>
  <magnify pixel="1">
    <zoom target="menubar" value="2"/>
    <zoom target="paint" value="3"/>
  </magnify>
</settings>
```

Preferences are kept in the browser's local storage as you change them, so
the file is for keeping and carrying, not for saving your work.

## Saving and documents

**Save** keeps a named document in Pea's local document collection. The first
save asks for its name. **Save As…** creates or explicitly replaces another
named document and makes it the active document. **Open…** lists saved
documents for the current editor. **Import…** reads a file from your device;
**Export a copy…** downloads a portable file. Export does not change which
named document Save updates.

The Documents app searches and filters saved documents, previews text,
paintings and the first card of a stack, and can open, rename, export or
delete them. Start also searches document names. Documents are files, kept
wherever the files service keeps files here: each is `documents/<id>.xml`, a
small XML file naming its app and holding its content, readable without Pea
OS. On disk under `pos serve` they sit in the data folder with your music;
in a browser they live in IndexedDB. Preferences, notes and desktop
arrangement use small separate local records.

Unsaved changes are marked in the editor. New/Open/Import ask before replacing
work. Recovery drafts are separate from explicitly saved documents and can
be restored after a restart. A failed save leaves the working document open;
a conflicting save from another window is rejected with guidance to Save As
or reopen. Recovery is best effort, not a substitute for exporting valuable
work: browser data is local to a profile and origin and can be cleared.

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd+S | Save |
| Ctrl/Cmd+Shift+S | Save As |
| Ctrl/Cmd+O | Open a saved document |
| Ctrl/Cmd+N | New document |
| Ctrl/Cmd+Z | Undo |
| Ctrl/Cmd+Shift+Z or Ctrl+Y | Redo |
| Tab / Shift+Tab | Move between controls |
| F10 | Open the menu bar |
| Ctrl+Escape | Open Start |
| Ctrl+Alt+Left / Right | Switch desktop |

## Notepad

Notepad edits plain text with caret movement, selection, scrolling, undo/redo,
find, previous/next match and a line/column/character count. Ctrl/Cmd+F opens
Find; F3 and Shift+F3 step through matches. Import/export uses ordinary UTF-8
text files. The editor accepts up to two million characters. The browser
adapter uses a native textarea for keyboard composition and clipboard input;
the visible editor retains Pea's pixel-art presentation. The bundled pixel
font has a limited glyph set: unsupported characters are retained in the
document but may display as fallback glyphs.

## Sticky Notes

Use Start › New note, Desk › New sticky note, or right-click the desk to put
one exactly there. A new note appears in view, in a clear spot beside your
windows and icons; the desk does not scroll. A note is an editable object
on its desktop: drag its header, write in its body, and drag its corner to
resize it. Its header is a window caption in the note's own paper, showing
its first line. Point at the header, or write in
the note, and five color chips appear; each new note takes the color after the
newest one. A double tap on the header rolls the note up to just its header.
The note's context menu edits, duplicates, rolls up, hides, recolors, moves it
to another desktop or archives it.

Position, size and text persist separately from app documents. The close
box at the left of the header hides a note. The Sticky Notes manager searches notes, shows each one's
color, desktop and when it was last changed (make its window taller and the
list grows with it), reveals, duplicates and archives
them, restores the latest archived note, exports all notes including the
archive, and imports a validated note file without replacing existing notes.
Files from earlier releases import unchanged.

Notes are limited to 80 total, including archived notes, and 8,192 characters
per note. No archived note is silently removed to make room. **Empty archive…**
asks before permanently deleting archived notes. Export first to keep a copy.
If storage fails, edited notes stay available in memory and can still be
exported; the manager displays the failure.

## Pea Records

A small card-file database. A database is a set of fields (text, number,
date, yes/no, choice or long text) and the records that fill them in.

- **Browse** shows one record as a form. The book in the status area turns
  back with its upper page and forward with its lower page; the rail under it
  jumps anywhere; Page Up/Page Down and Ctrl+↑/↓ turn pages from the keyboard.
- **List** shows the found set as a table. Tap a heading to sort by it (tap
  again to reverse); double-tap a row to open it.
- **Find** narrows the found set to records that match every field you fill
  in: part of a word, `=exact`, `>30`, `<=10`, `1..9`, or
  `2026-04-01..2026-04-30` for dates. **Show all** brings everything back.
- **Fields** adds, renames, retypes, reorders and deletes fields. Renaming a
  field keeps its values.

Records are named documents with Save, Save As, Open, Import, Export, undo and
recovery. The file format is XML (`<database>` of `<field>` and `<record>`);
`res/data/seeds.xml` is the example catalogue Records opens with.

## Pea Feeds

An RSS and Atom reader. **Add feed…** takes the address of a feed or of a web
page that announces one. Feeds more than fifteen minutes old are fetched when
the window opens, and again every fifteen minutes while Pea OS is open (the
schedule service); **Refresh** fetches them all now. Feeds come through the
internet service, and where nothing gives it, the status line says why. Articles are kept (forty per feed) so the reader opens
with something to read, and unread articles are marked. **More…** refreshes,
renames or removes one feed, and imports or exports subscriptions as OPML.
A feed that cannot be reached shows why in the list. The bundled *Pea OS
News* feed (`pea:pea-news`) works offline.

## Pea Flow

A little visual language in which objects travel. Drag nodes from the list
onto the board (or double-tap one in the list, or right-click the board),
then drag from an output port on a node's right edge
to an input port on another's left edge. Press **Run**: every object is a
small ball that moves along its wire, so you can watch the program work.
Numbers are blue, text yellow, yes green, no red and pulses white.

| Kind | Nodes |
| --- | --- |
| Sources | Clock, Button, Number, Text, Random |
| Transforms | Counter, Math, Compare (sends to *yes* or *no*), Toggle, Delay, Format |
| Sinks | Display, Lamp, Log, Plot |

Select a node to change its settings below the board; Delete removes the
selection; pulling a wire off an input picks it up again. Drag a node's
bottom-right corner to resize it: a larger Display wraps long text, a taller
Log shows more of its last 50 lines, a wider Plot draws more of its last 160
numbers, and a Lamp or Button grows with its node. **Default size** in the
node's menu puts it back. Drag empty board to
pan; the mouse wheel zooms about the pointer (50%, 100%, 200%, 300%; Shift
and the wheel scroll instead), as do **-**, **+** and the percentage, which
returns to 100%. F5 runs and pauses. Programs are XML documents (`<flow>` of `<node>` and
`<wire>`) with the usual Save, Open, undo and recovery; running never changes
the document. At most 300 objects travel at once, so a runaway loop is
reported instead of freezing the desktop.

## Agent Flow

Build a team of agents and watch them pass messages. Each node is an agent or
a helper; a wire carries a message, drawn as a little envelope, from one to
the next. Agents think with a language model when one is set up and with
**Pea Mind**, Pea's own rule-based thinker, when not, so every flow runs
offline.

| Group | Nodes |
| --- | --- |
| Start and finish | **Ask** (what you want), **Result** (what the team made) |
| Think | **Prompt**, a fill-in prompt with named answers (below); **Agent**, in a role: plan, ideate, solve, test, review, repair, verify, summarize, write, classify or chat, with your own instructions, thinking with the best thinker available, with Pea Mind only, or with the model server only |
| Steer | **Router** (sends the message down one of three roads by its words; the others are skipped), **Join** (waits for every helper and puts their answers together), **Check** (word counts and must-mention words; sends the work back to improve it, a few tries at most) |
| Make, offline | **Poet** (couplets, haiku, limerick, acrostic), **Story shape** (Kurt Vonnegut's shapes of stories, drawn on the node), **Song**, **Novel plan**, **Family ideas**, **Word game** (sentence patterns filled at random) |

**Prompt** is the plain-text way to ask for named answers. Write the prompt
with double curly braces where inputs go, and the answer you want as one
`name: example` per line:

```
Prompt:   Make up a short, friendly username for someone called
          {{firstName}} {{lastName}}. Use only small letters and digits.
Answer:   username: alice123
```

The node grows an input port for each `{{name}}` and an output port for
each answer line, so `firstName` and `lastName` wire in and `username`
wires out. Pea ends the prompt with a strict answer format for you. A thinker
that can enforce JSON (a /v1 server, the browser's model) gets a JSON schema
and the matching instruction; any other gets "Reply with exactly these lines,
and nothing else", with your examples. The reply is read either way: JSON,
JSON in a code block, or lines with bullets, bold names or values running on.
A reply that misses the form is asked for once more; an answer still missing
skips its wire. Changing the text changes the ports, and wires to a port that
is gone are removed. Offline, Pea Mind fills the form by rules.

**Templates…** starts from a ready-made team. *Make*: a poem, the shape of a
story, a bedtime story and lullaby, a song, a novel plan, silly sentences, a
story starter (a fill-in prompt with three answers).
*Family*: weekend ideas. *Team*: the classic agent patterns:

- **Team solve**: plan, two kinds of ideas side by side, solve, test, review,
  repair, verify.
- **Step by step** (sequential): outline, draft, polish.
- **Many helpers at once** (parallel): three helpers, then a judge.
- **Try again until it is good** (evaluator and optimizer): a writer and a
  checker that sends the work back.
- **Which way?** (routing): a router picks a poet, a storyteller or a helper.
- **Fill in the blanks**: first and last name into a prompt, a username out.

Press **Run** (F5). A node shows whether it is waiting, thinking, done,
skipped or failed, and what it last said; select it to read all of it and
change its settings. **Result** holds what the team made, with **To Notepad**
and **Sticky note**; **Messages** lists every message, and a double tap reads
one. **Stop** (or Escape) ends a run. A node acts once every wire into it has
brought something, so a Join waits for all its helpers; a wire that loops back
(drawn dashed) wakes its node again with the feedback. At most 200 messages
are sent in one run, so a runaway loop stops instead of running for ever.
Flows are XML documents (`<agentflow>`) with the usual Save, Open, undo and
recovery; editing a flow stops its run.

The board pans, zooms with the wheel and takes nodes dragged from the list,
like Pea Flow's. Drag a node's bottom-right corner to resize it: a wider node
shows long port names in full, and a larger one shows more of what it said,
keeping its line breaks. **Default size** in the node's menu puts it back.

## Software

The **Software** icon lists what is installed. Every app ships inside Pea OS,
so installing one downloads nothing: **Remove** hides an app from the desktop and
Start and keeps its documents; **Install** brings it back. Settings, Software,
Documents and About always stay.

Pea downloads data where the platform allows it (models, images, audio,
documents), but never code, which keeps supply-chain attacks out.

**Providers** is one tree of every service: under each, every provider Pea
knows of in the order they are tried, with a mark for its state (in use,
ready, cannot work now, not offered here) and, under a provider, the services
it requires in turn. Pick a row to read why, in plain words, and to turn a
provider on or off; pick a service to see which apps and providers depend
on it. An app's page in **Apps** says which services it needs or uses and
who gives each one here. Apps ask for a service and never learn who gave it
(see Providers below).

**Thinking** is how Pea answers prompts:

| Thinker | Here |
| --- | --- |
| Pea Mind | Built in, offline, always installed. |
| Model server (/v1) | Ready once Agent Chat › Setup names a server and a model. |
| Built-in browser AI | The browser's own model through the Prompt API: Gemini Nano in Chrome 148 and newer, on desktop computers with enough disk and memory. If the browser can fetch its model, **Install** asks it to (several gigabytes, once; the browser does the download, not Pea). Firefox and Safari have no such API: *Incompatible: this browser has no built-in model (the Prompt API).* |
| WebLLM (in this browser) | Shown, never fetched. Without WebGPU: *Incompatible: WebLLM requires WebGPU, which this browser or device does not offer.* With WebGPU: *Not installed: WebLLM is a third-party library. Pea OS never downloads code; a copy supplied with Pea OS is needed.* |
| On-device model | *Incompatible: only on phones and tablets running Pea OS natively.* The native bridge is not built yet. |

When agents are left to choose (*best thinker*), Pea takes the first ready
thinker in the order server, browser AI, WebLLM, on-device, Pea Mind, and if that one
fails mid-run (a server that is down, say), it answers with Pea Mind instead
and says so, so a flow still finishes.

**Files** is where documents, music and videos are kept: **Disk (pos serve)**
when Pea OS was opened from `pos serve` (ordinary files in the data folder),
**Browser storage** (IndexedDB, for this site), **Phone storage** natively on
a phone, **Preferences storage** (small files beside Pea's preferences, up to
2 MB, where nothing better is offered), and **Memory**, which is always there
and forgets when Pea OS closes.

**Internet** is how apps reach sites: the **Relay (pos serve)** reaches any
site from a page opened from `pos serve`; **Direct from this page** reaches
only sites that let other pages read them; **Phone network** natively on a
phone. **Schedule** runs work again and again, such as fetching feeds:
**While Pea OS is open** everywhere (a browser never wakes a closed page);
**Android background work** is not built yet. **Pea server** is `pos serve`
itself, which disk files, ffmpeg and the relay require.

**Sound** is what plays it: **Browser audio** (the page's own media player
with the Media Session API, so the lock screen, notification shade, media
keys and headsets control it) or, natively on Android, **Android media
player** (see Jukebox).

**Video tools** is ffmpeg. **ffmpeg (pos serve)** runs the ffmpeg already
installed on this computer; installing ffmpeg is up to you and your
platform: `dnf install ffmpeg` or `apt install ffmpeg` on Linux, `brew
install ffmpeg` on macOS, `winget install ffmpeg` on Windows; then restart
`pos serve`. **ffmpeg.wasm** is listed but needs a copy supplied with Pea OS,
because Pea never downloads code. **ffmpeg on Android** is not built yet. A
static web host has no video tools, so Pea Cut is simply not installed there:
an app that `requires` a service appears only where a provider gives it.

## Providers

A provider gives one service, the way the model router has always given
thinking. It is `{ id, title, kind, about, status(), requires, ...the
service's methods }`; `status()` says in words whether it works here, and
`requires` names the services it cannot work without. The platform hands Pea
OS the providers it really has (`platform.providers`); `res/data/software.xml`
names every provider Pea knows of, so one this platform lacks is still listed
with why. A provider is used only while everything it requires is given, so
one build adapts by itself: from `pos serve`, files go to disk and requests
through the relay; on a static web host, the Pea server is missing, so disk,
ffmpeg and the relay step aside with that one reason, files stay in the
browser and the page asks sites directly. For each service,
`os.providers.<service>.current` is the provider that works now, as a
signal:

| Service | What its providers do | Browser from pos serve | Static web host | Android (native) | Tests |
| --- | --- | --- | --- | --- | --- |
| thinking | answer prompts (`os.ai`) | as listed above | as listed above | as listed above | Pea Mind |
| files | list, read, write, remove, a playable source | Disk, Browser storage | Browser storage | Phone storage | Preferences storage |
| audio | a player with lock-screen controls | Browser audio | Browser audio | Android media player | a silent test player |
| media | probe, preview frames, loudness, render | ffmpeg (pos serve) | none | none yet | ffmpeg through a real `pos serve` |
| network | requests, streamed as they arrive | Relay | Direct from this page | Phone network | what a test answers |
| schedule | run work every so often | While Pea OS is open | While Pea OS is open | While Pea OS is open | While Pea OS is open |
| server | what pos serve offers | pos serve | none | none | a real `pos serve` |

Preferences storage and memory are behind every files column; the schedule
and Pea Mind are built in everywhere.

## Jukebox

A playlist player in the **Play** group. The main window has the time, the
scrolling title, a spectrum, the position, previous, play/pause, stop, next,
eject (add files) and the volume; **Shuffle** plays every track once before
any repeats, **Repeat** starts the list again. The playlist is a tool window
of its own, docked beside the player: double-click a track to play it, **Add
files** copies music from this device into Files › `music`, **Add stored**
adds what is already there, and **Open list** / **Save list** read and write
XSPF, the XML playlist format. The list itself is kept between runs. Closing
Jukebox stops the music; minimizing it, or switching to another app or tab,
does not.

Jukebox is careful where it runs. In a desktop browser the sound goes through
Web Audio so the spectrum can dance. On a phone it never does: the page's
media element plays straight to the system, which keeps it going with the
screen off under its media notification, and the spectrum stays still. Natively
on Android, the **Android media player** provider uses Android's MediaPlayer
with a partial wake lock, inside a foreground service of type `mediaPlayback`
with a MediaSession and a media notification, takes audio focus (pausing for
calls, ducking for navigation) and pauses when headphones are pulled out. That
is what Android asks of a music player so it is not put to sleep. The
NativeScript app must declare the service and permissions listed at the top
of `src/platform/nativescript-media.js`. It is written to Android's APIs but,
like the rest of the NativeScript adapter, not yet run on a device.

## Pea Cut

A video editor in the **Create** group, and a front end to ffmpeg, as Shotcut
is. It is installed only where the video tools service is (see Software).

1. **Import** copies videos and sound into the media provider's files
   (Files › `video`); **Stored** adds files already there. ffmpeg probes each
   for its length, picture size and sound.
2. In the **monitor**, move the slider to look at a source, **Set in** and
   **Set out**, then **Make clip**. Clips are listed under **Clips**; choosing
   one shows its range again.
3. Drag clips (or whole sources) onto the **timeline**, or press **To video**
   and **To audio**. The video track plays its clips one after another, each
   with its own sound under it (with a waveform, **Mute** and **Volume**). The
   audio track holds music and sounds at any time, mixed under the video.
4. On the timeline, click to move the marker (the monitor follows), drag a
   clip to reorder it or move a sound, drag a clip's edge to trim it, **Split**
   at the marker (or S), **Delete**, and use the wheel to zoom (Shift to
   scroll). Every change can be undone.
5. Choose a picture size and frame rate and press **Render**. ffmpeg renders
   H.264 and AAC in MP4 (VP9 and Opus in WebM where H.264 is missing) into
   Files › `renders`, with progress; **Stop** stops it and leaves nothing
   half-written. **Watch** plays the last render in a new tab.

A project is a named document like any other (File › Save), written in the
XML video project language of `src/os/video-project.js`. pos serve checks it
again and probes every source itself before running ffmpeg, which it starts
without a shell and with arguments made only from checked file names and
numbers.

## Agent Chat

Chat with a language model on any server that speaks the common
`/v1/chat/completions` protocol: Ollama, llama.cpp, LM Studio and vLLM on this
computer, or a hosted service. In **Setup**, enter the base URL ending in
`/v1` (for Ollama, `http://127.0.0.1:11434/v1`), an API key if the server
needs one, and a model; **Load models** asks the server which it has.
Replies stream in as they are written; **Send** becomes **Stop** meanwhile.

With **Pea tools** on, the model may open apps, write sticky notes, list apps,
notes and documents, and read the clock. Every tool call is shown in the
conversation. **To Notepad** and **Export** keep a Markdown copy. The setup
(including the key) and the conversation are kept in this browser's storage.

## Developer tools

Five small apps in the **Develop** group. They work offline, except HTTP Probe,
and keep nothing you type beyond the window's life.

| App | What it does |
| --- | --- |
| **Regex Lab** | A pattern, its flags and sample text. Every match is listed with its numbered and named groups (the first 500); picking one selects it in the text. A replacement (`$1`, `$<name>`, `$&`) shows the text after replacing, once without `g` and everywhere with it. |
| **JSON Lens** | Says whether text is JSON and, if not, the line and column where it stops being JSON. **Format**, **Minify** and **Sort keys**, with 2 or 4 spaces or tabs. Every value is listed by its path (`$.apps[0]`), with its type; a filter narrows the list, and picking a path in formatted text selects its line. |
| **Text Diff** | Two texts side by side and the fewest lines taken out (red) and put in (green) to turn one into the other, with unchanged runs folded. **Ignore spaces**, **Swap**, and **To Notepad** as a unified diff (`diff -u`). |
| **HTTP Probe** | GET or POST to an address, with headers (`Name: value` lines) and a body. Shows the status, type, size and time, and a JSON answer indented. **Send** becomes **Stop** while waiting; History brings a request back. Requests go through the relay below, with its limits. |
| **Codec Bench** | Base64 (also URL-safe), URL, hex and HTML escaping both ways; SHA-256 and SHA-1; reads a JSON Web Token's header and claims, with dates spelled out (the signature is not checked); Unix time to a date and back; new UUIDs. **Use output** feeds the result back in. |

Regular expressions run in the page: a pattern that backtracks badly on long
text can freeze it until it finishes, as in any browser tool.

## The network

Feeds and chat servers rarely let a web page read them directly, so in a
page opened from `pos serve` the internet service asks the server to make
the request instead (`/__pos/relay`). The relay answers only this computer,
only Pea OS pages opened through `127.0.0.1` or `localhost`, only http and
https, with a 16 MB and two-minute limit, and it never logs addresses,
headers or bodies. Streamed answers stream through. A page served some other
way asks sites directly, and says so when a site does not let it read.

The disk files and ffmpeg endpoints (`/__pos/services`, `/__pos/files`,
`/__pos/media`) follow the same rule, so a phone reaching
`pos serve --host 0.0.0.0` keeps its files in Browser storage, not on the
computer's disk.

## Paint

Paint keeps a fixed-size document inside a scrolling viewport. Pencil, eraser,
fill, line, rectangle and color-picker tools work with undo and redo. The
dimension control changes the picture itself, explicitly, up to 512×512.
Save/Open use named documents; editable export is XML. **PNG** exports an
image suitable for other applications. Resizing the screen or window does
not crop or rescale the stored painting.

## Pea Cards

A stack of cards. Each card has a picture, text, and buttons that lead to
other cards: enough for a story, a guide, a quiz or a little adventure.

- **The hand** browses: tap a button to follow it, tap text to change it.
- **The button tool** and **the text tool**: tap the card and one appears.
  Type to name it, drag to move it, drag its corner to resize it.
- **Pencil, eraser, bucket**: draw on the card in sixteen colors.
- A new button leads to the next card. To lead anywhere else, press **Link**,
  go to the card you mean, and press **Link here**.

The stack supports named documents through File › New, Open, Save and Save As.
**Export** writes an XML file; **Import** reads it back. `res/stacks/welcome.xml`
is an example. The old single autosaved stack is migrated without deleting its
original backup. Undo and redo cover card editing and painting, and the text
inspector supports a caret, selection and clipboard editing.

## Pea Timer

An interval timer with a small pixel hero who works out with you. A session
is a warm-up, rounds of work with rest between them, and a cool-down. During
each work interval the hero does curls, then presses, then lateral raises,
a third of the interval each.

- **Start**, **Pause**/**Go on**, **Skip** and **Reset**; Space starts and
  pauses. The stage shows the time left in this interval, the time left in
  the whole session, and a strip with one segment per interval in its
  phase's color.
- **Quick**, **Classic** and **Long** are ready-made plans. **Plan** opens
  steppers for warm-up, work, rest, cool-down and rounds (5 s steps under a
  minute, 15 s under five minutes, then whole minutes; a warm-up, rest or
  cool-down can be off). Your times are the **Mine** plan. The plan is
  locked while a session runs; Reset unlocks it.
- Square-wave beeps start the session, count down the last three seconds of
  each interval, and mark each phase. **Sounds** in the Plan tool or in
  Settings turns them off. A minimized timer keeps time and keeps calling
  the phases; closing its window pauses it.
- **Hero** designs the look: name, skin, build, hair, clothes, shoes, an
  extra and an accent color. Each finished workout raises the level (up to
  6), and levels unlock the gi, neon colors, the cape, gold and the crown.
  A workout with a skipped work interval earns no level; skipping a warm-up
  or rest is fine.
- With Animations off, the hero holds still and the hearts and confetti stay
  put.

The hero, the plan, the finished-workout count and the chosen preset are one
small XML document, `<pea-timer>` with `<plan>` and `<hero>`.

## Make an app

An app is one XML file. State is declared, the view binds to it with
`{name}`, and controls name the commands they run.

```xml
<app version="1" id="counter" title="Counter" sprite="calc" tint="#ffd75e" width="120" height="70">
  <state>
    <signal name="count" type="number" value="0"/>
    <signal name="loud" type="boolean" value="false"/>
  </state>
  <view>
    <column padding="6" gap="5" align="center">
      <label text="Count: {count}" scale="2"/>
      <check text="Loud" value="{loud}"/>
      <button text="Add one" action="add" kind="accent"/>
      <button text="Close" action="close"/>
    </column>
  </view>
</app>
```

Behavior, when an app needs any, is a script whose default export receives
the app:

```js
export default function counter(app) {
  const count = app.signal('count');
  app.command('add', () => count.update(n => n + 1));
}
```

Register both in `manifest.xml` and add an icon in `res/desktop.xml`:

```xml
<app id="counter" src="res/apps/counter.xml" script="res/apps/counter.js"/>
```

Settings (`res/apps/settings.xml`) has no script at all: every control is
bound to a system signal such as `{os.theme}` or `{os.smooth}`.

`width` and `height` are the size of the content. A window can be resized
down to `min-width` and `min-height` (by default it can only grow), and
`resize="false"` fixes its size. An app may also have tool windows; their
views share the app's state, and they take the same `width`, `height`,
`min-width`, `min-height` and `resize` attributes:

```xml
<tool id="colors" title="Colors" width="46" height="90">
  <view>
    <choice value="{color}">
      <option value="red" sprite="swatch-red"/>
    </choice>
  </view>
</tool>
```

Document apps use `createDocumentController` with small `parse`, `serialize`,
`install` and `create` functions. The shared controller owns New/Open/Save/Save
As, dirty state, recovery and bounded undo history; each app owns its file
format. `app.download(name, content, mimeType)` exports a file and
`app.pick('.xml')` imports one. The legacy `app.document` adapter remains for
compatibility. Window positions belong to the shell.

Widgets: `row`, `column`, `grid`, `panel`, `spacer`, `label`, `button`,
`check`, `slider`, `choice`, `image`, `canvas`, `field`, `textarea`, `list`,
`select`, `scroll`, `split`, `tabs`, `tab`. A `canvas` hands a script a
bitmap and pointer and wheel events, and may opt in to a context menu and
cursor shapes; Pea Paint, Pea Catch, Pea Flow and the Records book are built
on it. `<field secret="true">` shows dots instead of its text and will not
copy it out.

An app's `category` (create, organize, connect, develop, play, utility or
system) places it in the Apps menu and Start, and `summary` is the line Start
shows under its name. Services are declared, space-separated: `requires="media"`
names those the app cannot work without, so it is installed only where a
provider gives them; `uses="network schedule"` names those it is better
with, so it runs anywhere. The script reaches only declared services, as
`app.service('media')`: `ready` is a signal, `use()` hands over the
provider or fails with a sentence such as "Pea Feeds can't reach the internet
here. …", and `why()` is that sentence. `app.pickFiles(accept, { multiple })`
lets the user choose files of any kind (`[{ name, type, size, data }]`). Scripts may also `app.request({ url, method, headers, body,
onText })` through the internet service, which they must declare, `app.openUrl(url)` a web page, `app.menu(items,
event)` a popup menu, and `app.play([{ hz, ms }])` a few square-wave notes
(silent when Sounds is off). `app.frame(fn)` runs while the window is on
screen; `app.frame(fn, { background: true })` keeps running while it is
minimized, for clocks. `app.open` and `app.visible` are signals.

Mistakes do not pass silently. An unknown tag, attribute, signal, sprite,
color or command stops the app from loading and names the file and line:

```
res/apps/counter.xml:8: <label> text="Count: {cuont}": Unknown signal "cuont". Declared: count, loud
```

## Shape the shell

`res/desktop.xml` holds the menu bar, the taskbar's launcher, every context
menu and the icons. Menus are lists of items that run commands:

```xml
<context for="window">
  <magnify/>
  <separator/>
  <item text="Maximize" action="window:maximize" check="window.max"/>
  <send/>
  <item text="Close" action="window:close"/>
</context>
```

`<apps/>`, `<themes/>`, `<desks/>`, `<send/>`, `<tools/>` and `<magnify/>`
expand into items by themselves. An item may add `icon="glyph-save"` (a 7×7
shape drawn in the text color) or `icon="mini-paint"` (a 9×9 color picture),
and `shortcut="Ctrl+S"`. Glyphs and mini icons live in
`res/sprites/glyphs.xml`; every app has a `mini-<id>` there, which task
buttons use too. The commands are `launch`, `close`, `set`,
`toggle`, `fullscreen`, `start`, `overview`, `switcher`, `new-note`, `notes`, `file`, `window`, `tool`, `magnify`, `desk`, `send`, `arrange`,
`show-desktop`, `save-settings` and `load-settings`; a misspelled one stops the
shell from loading and names the line.

## Themes

Pick one from the **Theme** menu. Five are desktops; five are screen-saver
scenes, made to be watched while windows sit out of the way (pan them aside).
With **Pixels › Animations** off, every scene holds still.

| Theme | Backdrop |
| --- | --- |
| Pea Garden | Hills, a sun and drifting clouds |
| Arcade Sunset | A striped sun over a scrolling grid |
| Midnight Pod | Moon, ridges and twinkling stars |
| Classic 1986 | A two-color dither |
| Pocket Pea | Four shades of handheld green |
| Deep Reef | Fish cross a sunlit reef; bubbles rise from the sand past the kelp |
| Hyperspace | The desk flies through the stars, near ones streaking past |
| Rain City | Rain on a city at night, splashing in the street; lights go on and off |
| Fireworks | Rockets climb over a harbor and burst in two colors |
| Pea Squadron | Winged peas flap across the evening sky, small ones far behind |

## Make a theme

```xml
<theme version="1" id="garden" name="Pea Garden" wallpaper="garden" radius="3" title="stripes">
  <color role="ink" value="#22302a"/>
  <color role="paper" value="#fbf7ea"/>
  <color role="accent" value="#46b04a"/>
  <!-- every other role falls back to one of these three -->
</theme>
```

- `wallpaper`: `garden`, `sunset`, `night`, `dither`, or one of the five
  screen-saver scenes: `reef`, `warp`, `rain`, `fireworks`, `squadron`
- `title`: `stripes`, `bands` or `solid` window captions
- `radius`: corner roundness, 0 to 5
- `palette="#0f380f #306230 #8bac0f #9bbc0f"` locks every pixel on screen to
  those colors, as Pocket Pea and Classic 1986 do

Icons and game art are XML too (`res/sprites/*.xml`): rows of characters,
each a palette key. So is the font (`res/fonts/pea.xml`).

## Where things are

```
manifest.xml        the authoritative map: entry points, components, resources
res/                fonts, sprites, themes, the desktop shell, apps, stacks, data
src/core/           signals, scopes, the XML reader, provider sets and their registry
src/gfx/            bitmaps, font, sprites, themes, skin, the Pixi stage
src/ui/             widgets and the XML view language
src/os/             kernel, desktop model, shell, windows, taskbar, wallpapers,
                    services and providers, files, documents, the video project language
src/ai/             the agent protocol, the model router, Pea Mind, agent flows
src/platform/       browser and NativeScript adapters, and the providers they give
cli/ bin/           the pos tool, development server (with disk files and
                    ffmpeg), headless compositor
test/               node --test suites
```

[ARCHITECTURE.md](ARCHITECTURE.md) explains the contracts between these
layers. [TODO.xml](TODO.xml) records what is done and what is next.

## Platforms

| Platform | State |
| --- | --- |
| Browser (canvas, WebGL) | Browser adapter and bundled renderer included. The 0.3, 0.4 and 0.5 changes are validated headlessly; real-browser, clipboard/IME, file-dialog and network-relay verification remains outstanding. See ARCHITECTURE.md. |
| Headless (Node) | Works; used by `pos check`, `pos shot` and the tests |
| NativeScript (Android, iOS) | Existing adapter is included but has not been device-tested, nor have its phone storage, Android document picker and Android media player. Native text/IME, sharing, PNG export and an iOS player still need platform adapters. |

Pea OS pins pixi.js 8.5.2, the version `@nativescript/canvas-pixi` builds
against, and reaches Pixi through one module (`src/gfx/stage.js`).

The NativeScript toolchain needs npm packages and the Android SDK. Those
belong in a Docker image, never on the host; that image is the next piece of
work and is described in TODO.xml.
