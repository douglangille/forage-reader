# Forage for Obsidian

A desktop-only Obsidian plugin that reads from a running [Forage](https://github.com/douglangille/forage) server. The feed list lives in a sidebar, the article opens as a normal tab (rendered by Obsidian, so it takes your theme), and one click writes it into the vault as a Web Clipper-shaped note. Until you save, the article stays on the server.

It's deliberately thin. Feeds, folders, backfill, OPML and settings stay in the Forage web app.

## Setup

1. Run Forage and keep it reachable from this machine. It has no login, so keep it on a private network.
2. Install the plugin (BRAT, or clone into `.obsidian/plugins/forage-obsidian`), enable it, and set the server address in its settings.
3. Needs Forage with the `/api/entries/{id}/clip` and `/saved` endpoints.

## Use

The ribbon icon opens the list. Click an article and it opens in a single reused tab, so the note beside it stays put. The tab's header buttons save, star, mark unread and open the original. Every action is also a command, so bind your own keys: next/previous article, save, star, toggle read, check feeds.

MIT licensed, no telemetry. The only network traffic is to the server address you set.
