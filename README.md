# VoiceNotes: a voice-powered todo app

A mobile-first todo notes app with a voice assistant. It is plain HTML, CSS and JS with no build step, no backend and no cloud. **All data stays in your phone's browser (`localStorage`).**

| File | Purpose |
|---|---|
| `index.html` | App shell: Notes list screen, Note screen, assistant sheet, reminder sheet |
| `styles.css` | Dark theme: black background, white text, pastel green / yellow / red CTAs |
| `app.js` | Storage, routing, rendering, voice assistant, date parser, Google Calendar links |

## Screens
1. **My Notes** (home): search, note cards with progress, a big yellow **mic** button, and a green **New note** button. Long-press a card to delete it (you can undo).
2. **Note**: rename it, add items, tap the circle to tick an item, tap an item's text to edit it, use 🔔 to set a reminder and 🗑 to delete, plus "Clear completed".

## Voice commands
| Say… | Result |
|---|---|
| "Create a note called Groceries" / "…with milk, eggs and bread" | New note (with items) |
| "Add butter and jam to Groceries" / "Add bread" | Adds the items (to the open or last used note) |
| "Mark milk as done" / "Tick eggs in Groceries" | Ticks the item off |
| "Uncheck milk" | Marks it as not done |
| "Delete bread from Groceries" | Removes the item (you can undo) |
| "Delete the Groceries note" | Removes the note (you can undo) |
| "Open Groceries" / "What's in Groceries?" / "Go home" | Opens the note, reads it out, or goes back home |
| "Clear completed" | Removes the ticked items |
| "Remind me to pay rent tomorrow at 5 pm" | Saves the reminder and gives you an **Add to Google Calendar** button |
| "Set a reminder for Groceries on Friday at 10 am" | Sets a reminder for the whole note |

Understood times: today, tonight, tomorrow, weekdays, "in 30 minutes", "in 2 hours", "25 December", "12/1" (day/month), "at 5 pm", noon, morning, evening.

## Running it on your phone
Mic access only works over **https** (or `localhost`). It does not work when you open the file directly with `file://`.
- **Easiest:** enable GitHub Pages for this repo (Settings → Pages → deploy from branch). Then open the URL in Chrome on Android and choose *Add to Home screen*.
- **Local test:** run `python3 -m http.server 8000` and open `http://localhost:8000`.

## Notes and limitations
- **Google Calendar:** the app opens a pre-filled Google Calendar event and you tap **Save**. Creating events silently would need Google sign-in (OAuth) plus a cloud project, which goes against the local-only rule.
- **In-app alerts:** the app also gives an alert (sound, vibration and a notification) when a reminder is due, but only while the app is open.
- **Browser support:** voice works best in Chrome on Android. If speech isn't available, the assistant still accepts typed commands.
- **Privacy:** Chrome's speech recognition sends your *audio* to Google to turn it into text. Your notes are never uploaded.
