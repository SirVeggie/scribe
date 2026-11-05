# Page permissions

[← Permissions overview](../permissions.md)

Pages can run their own scripts: a Kanban board moves cards, a form saves answers, a voice notes page records audio. Reading and writing **its own data** needs no permission. Anything beyond that is a page permission, which you grant per page from its menu → **Permissions…**.

This is about the *page's code*. Which pages an *agent* may reach is a different layer: [Page access for agents](page-access.md).

## The permissions

| Permission | Lets the page | Starts as | Resets when an agent edits the page |
|---|---|---|---|
| **Agent chats when you click** | Start and continue its own chats after you click or press a key on it. Those chats have no files or shell | Allow | No |
| **Agent chats without a click** | Do the same from its own code, for example when a card moves | Ask | Yes |
| **Agents with file and shell access** | Start chats that work in folders you approve, up to the access level you set for each folder | Ask | Yes |
| **Files in folders you approve** | Read or save files in folders you approve, with Read, Write or Read & write for each | Ask | Yes |
| **Use the microphone** | Record after a click while it is visible. Scribe shows a recording indicator and a stop button | Ask | Yes |
| **Stream the live microphone to this page** | Receive the microphone's sound as it records, not just the clip at the end | Ask | Yes |
| **Play sounds** | Play sounds at your Scribe volume; without a click only while visible | Allow | No |
| **Turn speech into text** | Send audio to your speech-to-text source. With a hosted source, the audio leaves your PC | Ask | No |
| **Read text aloud** | Send its text to your text-to-speech source. A hosted source may charge per character | Ask | No |
| **Ask the classifier** | Send its text to your classifier, for example to suggest a card's labels | Ask | No |
| **Plugin: *name*** | Use an installed plugin's methods and widgets (one entry per plugin) | Ask; Allow on a page made from that plugin's template | When the plugin is marked risky |

Each one is **Allow**, **Deny** or **Ask**. With Ask, Scribe asks the first time the page needs it, in a dialog over the page: **Allow**, **Deny**, or **Not now**, which holds the question back for 10 minutes so a page can't ask in a loop.

### Folder permissions

Two permissions are granted per folder rather than as a whole:

```text
Agents with file and shell access          Files in folders you approve
  C:\Projects\site      up to Edits          C:\Renders     Write
  C:\Projects\docs      up to Read-only      D:\Photos      Read
```

- **Agents with file and shell access**: each folder has the highest [access level](chat-access.md#the-access-ladder) a chat started by the page may have there. A Kanban board's workers need this for their project folder.
- **Files in folders you approve**: *Write* lets the page save files without seeing what is already there; *Read & write* allows both.

A page can only ask for a folder that you then confirm; it never sees other folders.

## When grants reset

The riskier permissions (the ones marked *Yes* above) go back to **Ask** when an agent changes the page's code, or the template it comes from. That way a page you trusted can't gain abilities through an edit you haven't seen. When you allow one, you can tick **Don't ask again when an agent updates this page** to keep it through such edits.

Changes to the page's *data* (moving a card, ticking an item) never reset anything.

## Where grants live

Grants are stored on your PC, outside the page. They are not part of its HTML, state, download or export, so a page you share or copy to another device starts with the defaults there.

## For page authors

A page can check and ask ahead of time instead of when the feature is first used:

```js
const { permissions } = await scribe.permissions.query();   // [{ id, label, value: "allow" | "deny" | "ask" }]
await scribe.permissions.request("audio.microphone");       // asks now, after a click
```

The ids are `agent.chat`, `agent.unattended`, `agent.workspace`, `files`, `audio.microphone`, `audio.microphoneStream`, `audio.play`, `audio.transcribe`, `audio.speak`, `ml.decide` and `plugin.<id>`.
