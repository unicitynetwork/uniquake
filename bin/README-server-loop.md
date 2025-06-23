# UniQuake Server Loop Runner

This directory contains scripts for running UniQuake tournament servers in a continuous loop.

## Files

- `server-cli-loop.sh` - Bash script that runs server-cli in an infinite loop
- `uniquake-tournament.service` - Systemd service file for running as a background service

## Usage

### Running Manually

Basic usage:
```bash
./server-cli-loop.sh
```

With custom options:
```bash
./server-cli-loop.sh --master ws://192.168.1.100:27950 --name "My Tournament" --entry-fee 5
```

All available options:
```bash
./server-cli-loop.sh --help
```

### Options

- `--master <url>` - Master server URL (default: ws://localhost:27950)
- `--name <name>` - Server name (default: UniQuake Server)
- `--map <map>` - Map name (default: q3dm1)
- `--max-players <num>` - Maximum players (default: 16)
- `--entry-fee <num>` - Entry fee in tokens (default: 1)
- `--no-tokens` - Disable token system
- `--debug` - Enable debug logging
- `--restart-delay <sec>` - Delay between restarts in seconds (default: 2)

### Running as a Background Service

1. Copy the service file and edit it:
   ```bash
   sudo cp uniquake-tournament.service /etc/systemd/system/
   sudo nano /etc/systemd/system/uniquake-tournament.service
   ```

2. Update these values in the service file:
   - `User=YOUR_USERNAME` - Your system username
   - `Group=YOUR_GROUP` - Your system group
   - `WorkingDirectory=/path/to/uniquake` - Full path to uniquake directory
   - `ExecStart=` - Update the path and add your desired options

3. Enable and start the service:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable uniquake-tournament
   sudo systemctl start uniquake-tournament
   ```

4. Check service status:
   ```bash
   sudo systemctl status uniquake-tournament
   ```

5. View logs:
   ```bash
   sudo journalctl -u uniquake-tournament -f
   # Or check log files:
   tail -f /var/log/uniquake-tournament.log
   ```

6. Stop the service:
   ```bash
   sudo systemctl stop uniquake-tournament
   ```

## How It Works

1. The script runs server-cli with the specified options
2. When a match ends (time/frag limit), server-cli terminates
3. The script waits for the specified restart delay (default: 2 seconds)
4. A new server-cli instance is started for the next match
5. This continues indefinitely until interrupted (Ctrl+C or service stop)

## Features

- **Automatic Restart**: Server restarts after each match completes
- **Match Counter**: Tracks how many matches have been run
- **Error Handling**: Continues running even if a match ends with an error
- **Clean Shutdown**: Properly stops server when script is terminated
- **Logging**: Shows timestamps and match numbers for each iteration
- **Configurable**: All server-cli options can be passed through

## Example Output

```
=== UniQuake Server CLI Loop Runner ===
Configuration:
  Master Server: ws://192.168.1.100:27950
  Server Name: Tournament Server
  Map: q3dm1
  Max Players: 16
  Entry Fee: 5
  Tokens: Enabled
  Debug: Disabled
  Restart Delay: 2 seconds

Press Ctrl+C to stop the server loop
=======================================

🎮 Starting match #1 at Sat Jan 25 15:30:00 UTC 2025
----------------------------------------
[server-cli output here...]

✅ Match #1 completed successfully
⏳ Restarting in 2 seconds...

🎮 Starting match #2 at Sat Jan 25 15:45:03 UTC 2025
----------------------------------------
[server-cli output here...]
```

## Tips

- Use `screen` or `tmux` to run the loop in a detachable session
- Set up log rotation for long-running tournaments
- Monitor system resources as each match creates a new dedicated server process
- Consider using the systemd service for production deployments