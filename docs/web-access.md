# Browser access from anywhere

Web access lets you open Scribe on a phone or any computer with a browser. An always-on device with Scribe (see [An always-on server](../README.md#an-always-on-server)) serves it behind a TLS proxy, and only the Google accounts you list can sign in. Sessions last 30 days after their last use.

You need:

- The always-on server, paired with your PC.
- A domain or subdomain you control, such as `scribe.example.com`.
- [Caddy](https://caddyserver.com) (or another TLS proxy) on the server, with ports 80 and 443 open.

## Setup

1. **DNS.** Point the domain and its subdomains (`scribe.example.com` and `*.scribe.example.com`) at the server. Each page opens on a subdomain of its own, which keeps pages apart from each other and from Scribe itself.

2. **Google sign-in.** In the [Google Cloud console](https://console.cloud.google.com/apis/credentials), create an OAuth client ID of type *Web application*, with `https://scribe.example.com` as an authorized JavaScript origin. Copy its client ID.

3. **Caddy.** Pass the domain to Scribe's web port (`4750` by default; it only listens on the server's loopback). Scribe tells Caddy which names may get a certificate, so nobody can use up your Let's Encrypt allowance by asking for random names:

   ```caddyfile
   {
   	on_demand_tls {
   		ask http://127.0.0.1:4750/caddy-ask
   	}
   }

   https://scribe.example.com, https://*.scribe.example.com {
   	tls {
   		on_demand
   	}
   	reverse_proxy 127.0.0.1:4750
   }
   ```

4. **Scribe.** On your PC, open Settings → Devices → **Web access**, choose the server under **On**, and enter the web address (`scribe.example.com`), the Google client id and the accounts that may sign in.

Then open `https://scribe.example.com` and sign in with one of those accounts. A page you open for the first time may take a few seconds while Caddy gets its certificate.

On a phone, Scribe switches to a layout made for small screens, and you can add it to your home screen. Paired devices are reachable from the web view too, through the server.

To sign a browser out, use **Sign out** next to it in the same Web access section. Removing an account signs out all of its browsers.
