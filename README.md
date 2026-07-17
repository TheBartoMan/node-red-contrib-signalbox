# node-red-contrib-signalbox

A Node-RED node that does nothing to your messages - it passes them
through completely unchanged - but watches the traffic going past, the
way a signalman in a signal box logs every train that passes their
section of track. No configuration is required to use it.

## Install

From your Node-RED user directory (typically `~/.node-red`):

```
npm install node-red-contrib-signalbox
```

Or use the `Manage Palette` command in the Node-RED editor.

## Usage

Wire it into any point in a flow - one input, one output, message
unchanged. Optionally give it a **Name**, which is used as its label
inside `global.signalbox` (see below); if left blank, an auto-generated
label is used instead.

### Status badge

Updates continuously (not just when messages arrive), e.g.:

```
3s ago · 12/hr · 340/day
```

By default the dot also changes color as things get stale:

| Color  | Meaning |
|--------|---------|
| Green  | Fresher than **Warn after** |
| Yellow | Between **Warn after** and **Error after** |
| Red    | Older than **Error after** |

Untick **Change status color as it gets stale** for a neutral blue dot
with text only.

### Node context

Each instance writes a snapshot to its own node context under the key
`signalbox`:

```js
{
  id: "<node id>",
  name: "front-door-sensor",
  lastSeen: 1737000000000,
  counts: { hour: 12, day: 340, week: 2100, total: 58211 },
  avgIntervalMs: 4213,
  topPayloads: [ { value: "\"open\"", count: 88 }, ... ],
  topPayloadsSince: 1736913600000,
  updated: 1737000005000
}
```

### Global context: `global.signalbox`

Every instance also writes its snapshot into a single shared
`global.signalbox` object, keyed by node ID - so you can see every
signalbox in the whole Node-RED instance from one place:

```js
const all = global.get("signalbox");
const busiest = Object.values(all).sort((a, b) => b.counts.day - a.counts.day)[0];
```

### Top payload tracking

Tracks the top 10 most frequent payload values seen, using a tally that
resets on the **Reset tally every** interval (default: daily) rather than
a true sliding window, and is capped at 500 distinct values (least
frequent evicted first) to bound memory. Works best for payloads with a
naturally small set of repeating values (status strings, event names,
error codes) rather than continuously-varying data like raw sensor
readings. Untick **Track top 10 payloads by frequency** to disable this
entirely.

### Update interval

**Update every** controls how often the status badge refreshes and how
often snapshots are written to context/`global.signalbox` - it has no
effect on message flow itself, and is decoupled from message rate so a
high-throughput flow won't write to context on every single message.
Defaults to 5 seconds.

## A note on persistent context stores

If you've configured a persistent (non-memory) context store as your
default, each signalbox writes into it on every **Update every** tick.
With many instances, or a slow store, consider increasing the interval.

## License

Apache-2.0
