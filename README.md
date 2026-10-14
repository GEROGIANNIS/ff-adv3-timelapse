# FlashForge Adventurer 3 Timelapse

## Local use

Run the app on a computer connected to the same network as the printer, then enter
the printer's local IP address. The Adventurer 3 camera stream is served on port
`8080`.

```bash
npm start
```

## Render deployment

Render cannot connect to private addresses such as `192.168.x.x`, `10.x.x.x`, or
`172.16.x.x`. Entering a printer IP in the hosted site therefore cannot work: the
request is made by the Render server, not by your browser.

To use the hosted app, run a secure outbound tunnel on an always-on computer in
the printer's network, pointing it at the camera service. Then set the public
tunnel URL as this Render environment variable:

```text
PRINTER_CAMERA_URL=https://your-camera-tunnel.example.com
```

The app adds `?action=stream` automatically. A Cloudflare Tunnel is one option;
protect it with Cloudflare Access or another authentication layer and do not
expose the printer's port directly through router port forwarding. After changing
the Render environment variable, redeploy the service. The connection field will
show the configured tunnel host instead of accepting a local IP.
