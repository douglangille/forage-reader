# Forage Reader

A desktop-only Obsidian plugin that reads from a running [Forage](https://github.com/douglangille/forage) server, a self-hosted RSS reader. The feed list lives in a sidebar, the article opens as a normal tab rendered by Obsidian (so it takes your theme), and one click writes it into your vault as a Web Clipper-shaped note. Until you save, the article stays on the server.

It's deliberately thin. Feeds, folders (including Organize with AI), backfill, OPML, the card view and the server's settings stay in the Forage web app. This plugin is for reading, searching, summarizing and saving.

> **Forage has no login.** Run it only on a network you control (the author uses Tailscale). This plugin sends requests to whatever server address you give it and nothing else: no telemetry, no other network traffic.

## Install

Not in the community plugin directory yet. Install with [BRAT](https://github.com/TfTHacker/obsidian42-brat): add the beta plugin `douglangille/forage-reader`. Or download `main.js`, `manifest.json` and `styles.css` from the latest release into `<vault>/.obsidian/plugins/forage-reader/`.

Then enable **Forage** under Community plugins and set the server address in its settings (for example `https://forage.your-tailnet.ts.net`). The server needs a current Forage (0.3.0 of this plugin wants the build from 10/13/2026 or later): the plugin reads `/api/entries/{id}/clip`, which now also carries the kept AI summary, and uses `since_hours` and `q` on `/api/entries`.

## Use

- The ribbon icon opens the list in the left sidebar. Narrow, it's a dropdown plus list. Wide, a feed and folder tree appears beside it. Thumbnails hide when it's very narrow.
- **Recent** is the first item in the tree and dropdown, and the default for a new install: the last 48 hours, the same window as the web app. Your saved view stays as it was. The search box under the buttons matches titles and kept summaries.
- The eye button toggles unread-only. The check button marks the current view read, after a confirmation.
- Click an article and it opens in one reused tab, so the note beside it stays put. The tab's header buttons save, star, mark read or unread, open the original and, when the server has AI turned on, summarize. A summary is written on request, kept on the server, and shown above the article with the model's name. Reopening shows it without asking again, and the button hides or shows it.
- Save writes a clip into the inbox folder you set (default `inbox`). It keeps no record of it, so every press writes a new note (a repeat gets a numbered name). The star is the bookmark.
- Every action is also a command, so bind your own keys: next and previous article, save, star, toggle read, open original, check feeds. (Summarize is a header button only.)

## Notes

- Obsidian renders the article with every installed plugin's markdown post-processors, so a plugin that executes code found in notes (Dataview inline JS, for example) would treat article text like note text.
- Desktop only. On a phone, use Forage's own web app.

MIT licensed.
