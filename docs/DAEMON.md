# Daemon Mode

Pickme includes a daemon mode that provides significantly faster file search
by keeping the index warm in memory. Instead of loading the database on every
search, the daemon maintains a persistent connection and caches frequently
accessed data.

## How It Works

When you run `pickme serve`, the daemon:

1. Starts a Unix socket server at `$XDG_RUNTIME_DIR/pickme/pickme.sock`
   (or `/tmp/pickme-{uid}/pickme.sock` on macOS)
2. Loads the file index into memory
3. Listens for search requests from hooks
4. Returns results with sub-millisecond latency for cached queries
5. Auto-shutdowns after a configurable idle period (default: 30 minutes)

The `pickme query` command automatically detects if a daemon is running and
routes requests through it. If the daemon is unavailable, it falls back to
direct database access.

## Commands

### `pickme serve`

Start the daemon server.

```bash
pickme serve
pickme serve --idle 60
pickme serve -s /tmp/custom.sock
```

Options:

- `-i, --idle <minutes>` - Auto-shutdown after N minutes idle (default: 30)
- `-s, --socket <path>` - Custom socket path

The daemon runs in the foreground and logs activity to stderr. For background
operation, use your system's service manager or run with `&`:

```bash
pickme serve &
disown
```

### `pickme daemon status`

Check if the daemon is running and view health metrics.

```bash
pickme daemon status
pickme daemon status --json
```

Output includes:

- Socket path and whether it exists
- Running state (yes/no)
- Uptime
- Memory usage (RSS)
- Cache hit rate
- Index generation (bumped on invalidation)
- Active file watchers
- Loaded roots

Example output:

```text
Daemon Status
-------------
Socket: /tmp/pickme-501/pickme.sock
Running: yes
Uptime: 15m 32s
Memory: 45.2 MB
Cache hit rate: 87.3%
Index generation: 2
Active watchers: 3
Roots loaded: 2
  - /Users/you/Developer
  - /Users/you/.config
```

## Configuration

Add daemon settings to your `~/.config/pickme/config.toml`:

```toml
[daemon]
enabled = true           # Enable daemon mode (default: true)
idle_minutes = 30        # Auto-shutdown after idle (default: 30)
socket_path = ""         # Custom socket path (optional)
fallback_to_cli = true   # Fall back to CLI when daemon unavailable
```

## Query Routing

The `pickme query` command uses this decision tree:

1. Check if daemon is enabled in config
2. If enabled, check if socket exists
3. If socket exists, attempt health check
4. If healthy, route query through daemon
5. Otherwise, fall back to direct CLI (if `fallback_to_cli = true`)

You can force direct CLI access with the `--no-daemon` flag:

```bash
pickme query "*.ts" --no-daemon
```

## Protocol

The daemon uses a simple JSON-over-Unix-socket protocol:

### Search Request

```json
{
  "id": "req-123",
  "type": "search",
  "query": "component",
  "cwd": "/Users/you/project",
  "limit": 50
}
```

### Search Response

```json
{
  "id": "req-123",
  "ok": true,
  "results": [
    {
      "path": "/Users/you/project/src/Button.tsx",
      "score": 0.95,
      "root": "/Users/you/project"
    }
  ],
  "cached": true,
  "durationMs": 0.42
}
```

### Health Request

```json
{
  "id": "req-124",
  "type": "health"
}
```

### Health Response

```json
{
  "id": "req-124",
  "ok": true,
  "health": {
    "uptime": 932,
    "rss": 47448064,
    "generation": 2,
    "cacheHitRate": 0.873,
    "activeWatchers": 3,
    "rootsLoaded": ["/Users/you/Developer"]
  }
}
```

## Troubleshooting

### Daemon not starting

Check socket directory permissions.
The daemon requires a directory with mode `0700`:

```bash
ls -la /tmp/pickme-$(id -u)
# Should show: drwx------ (0700)
```

### Stale socket file

If the daemon crashed, the socket file may remain.
The daemon status command will warn about this:

```text
Note: Stale socket file exists (daemon crashed?)
```

Remove the stale socket and restart:

```bash
rm /tmp/pickme-$(id -u)/pickme.sock
pickme serve
```

### High memory usage

The daemon caches search results to improve performance.
If memory usage grows too high:

1. Reduce the number of indexed roots
2. Lower the result limit in queries
3. Decrease the idle timeout so the daemon restarts more frequently

### Slow initial queries

The first query after daemon startup will be slower as it populates caches.
Subsequent queries for similar patterns will be much faster.

## Architecture

```text
                    +------------------------------------------+
                    |              pickme daemon               |
                    |                                          |
+----------+        |  +---------+   +-------+   +--------+   |
|  Claude  | Unix   |  | Server  |---+Handler+---+FilePick|   |
|  Hooks   | Socket |  | (net)   |   |(route)|   |  er    |   |
+----+-----+        |  +---------+   +-------+   +--------+   |
     |              |        |                        |        |
     | JSON/newline |        |         +--------------+        |
     |              |        v         v                       |
     |              |  +---------+   +-------+                 |
     +--------------+--+  Cache  +---+ SQLite|                 |
                    |  | (LRU)   |   |  DB   |                 |
                    |  +---------+   +-------+                 |
                    |                                          |
                    +------------------------------------------+
```

Components:

- **Server**: Unix socket listener handling concurrent connections
- **Handler**: Routes requests to appropriate handlers
  (search, health, invalidate, stop)
- **FilePicker**: Core search implementation
- **Cache**: LRU cache for query results
- **SQLite DB**: Persistent file index storage
