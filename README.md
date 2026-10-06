# Bluesky comments for TiddlyWiki
Show the replies to a [Bluesky](https://bsky.app) post as comments on a tiddler. Announce a tiddler on Bluesky, paste the link of that post into a `bluesky-post` field, and the conversation shows up at the bottom of the tiddler. Please add a star if you like the plugin!

Demo: https://tw5-bluesky-comments.joselito.dev

- No login, no API key and no third-party service: the replies come from the public Bluesky API, straight to the visitor's browser
- Drawn with the wiki's own markup and palette, not an iframe, so the comments follow your theme
- Read-only: a *Reply on Bluesky* link opens the post, where anyone with an account can join in
- Avatars, names and handles, text with links, mentions and hashtags, images and link cards, reply/repost/like counts and nested replies up to a configurable depth
- Respects the choices of the people in the thread: replies from accounts that do not show their posts to logged-out visitors, replies hidden by the post author, and replies with adult content or spam labels are not shown

Setup steps and details are in the plugin's *Setup* tab.

Sibling of [tw5-github-comments](https://github.com/breakzplatform/tw5-github-comments), which keeps comments on GitHub.

## Installation instructions

### Drag'n'drop
- Open the demo TiddlyWiki: https://tw5-bluesky-comments.joselito.dev
- Drag the plugin box into your wiki

### Copy to a Node.js based wiki
- Create a `bluesky-comments` folder inside your wiki's `plugins` folder
- Clone this repo into the `bluesky-comments` folder

## Settings

In the *Bluesky comments* tab of the Control Panel:

| Setting | Default | |
|---|---|---|
| Filter | `[!is[system]]` | Which tiddlers can show comments. Only tiddlers with a `bluesky-post` field are affected |
| Reply depth | 6 | Levels of nested replies, from 1 to 20 |
| Order | Oldest first | Also newest first or most liked first, for the direct replies |
| Show counts | Yes | Replies, reposts and likes |
| Hidden labels | `!hide !warn porn sexual nudity graphic-media gore spam` | Moderation labels that hide a reply |
| API | `https://public.api.bsky.app` | The public Bluesky AppView |
| Links open in | `https://bsky.app` | Any client with the same URL layout |

The texts are in a language dictionary tiddler that can be edited to translate them.

## Development

The library that parses links and builds the reply tree has tests that run with plain Node:

```sh
node --test test/
```

To try the plugin in a local wiki, create one next to the repo and link the plugin into it (a wiki inside the plugin folder would be loaded as part of the plugin):

```sh
mkdir -p ../bluesky-dev/plugins
ln -s "$PWD" ../bluesky-dev/plugins/bluesky-comments
echo '{"plugins":["tiddlywiki/tiddlyweb","tiddlywiki/filesystem"],"themes":["tiddlywiki/vanilla","tiddlywiki/snowwhite"]}' > ../bluesky-dev/tiddlywiki.info
npx tiddlywiki ../bluesky-dev --listen
```

Then open http://localhost:8080 and create a tiddler with a `bluesky-post` field. The test folder has a `tiddlywiki.files` with no tiddlers, so the tests stay out of the plugin.

## License

[MIT](LICENSE)
