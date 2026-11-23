# Security

## Reporting

Open a private security advisory on the repository host, or contact the
maintainers directly. Do not file a public issue for a vulnerability that can
control devices, leak tokens, or reach a private camera stream.

## Design boundaries

- **Two credentials, two directions.** The push token authenticates
  `Miloco -> DSH`; the backend token authenticates `DSH -> Miloco`. They are
  separate secrets and must not be shared: one leaked value would otherwise
  open both directions. The settings page flags an installation that reuses
  one value for both.
- **Default read-only.** Write tools are not registered while the plugin runs
  in `readonly` mode. There is no runtime "hidden tool" that the model could
  still call.
- **Webhook fail-closed.** `/miloco/webhook` rejects every request when no
  push token is configured.
- **Push credential scope.** The push token is registered with the host
  connection as a credential for that route only, with a non-owner principal.
  It cannot open owner-only APIs, and it is useless on any other route.
- **Host credential registration (DSH 0.2.3+).** Since `0.2.3-alpha.1` the
  host serves every HTTP route with `auth: 'required'` by default, so a
  machine caller has to present a credential the host recognises. The plugin
  registers the push token through the host's credential registry
  (`ctx.connection.authentication`), which gives three properties:
  - the route declares `auth: 'required'`, so an unauthenticated request is
    refused by the host before it reaches the plugin;
  - the registered principal is `miloco-push`, **not** `owner`: the credential
    cannot open owner-only APIs (the gateway rejects non-owner principals);
  - the credential is accepted for the push route only — the provider checks
    the request path, so the same token is useless anywhere else.
  The credential lives in the plugin's own overlay file; the host only ever
  sees the comparison result, never the token.
- **Scope violations fail safe.** Reading a service the plugin did not inject
  is refused by the host (`cannot get property ... without inject`). The
  plugin resolves the credential registry by name, and if registration fails
  for any reason it registers the route as `anonymous` and logs a warning —
  the inbound route is never silently dropped, and the plugin's own Bearer
  check remains the fallback.
- **Token storage.** Connection and push tokens live in
  `$DSH_HOME/miloco-plugin.json` with mode `0600`; they are never returned to
  the browser.
- **Same-origin writes.** Settings mutations reject cross-site `Origin`
  headers.
- **No secrets in the repository.** The project ships no credentials, device
  ids, or Xiaomi account data.
- **No shell interpolation in deployment.** The deployer uses
  `spawn(command, args)`; the repository URL must be `https://`.
- **Package index selection.** The deployment measures the configured Python
  package indexes and uses the fastest one that serves the PEP 691 JSON API
  (the upstream installer pins its dependencies with `exclude-newer`, which
  needs the upload times only the JSON API carries). No credential is sent to
  an index.

## Operational guidance

- Prefer a dedicated Miloco backend token, not your Xiaomi account password.
- Rotate the push token from the settings page after any change on the Miloco
  side; the new value is published to Miloco and takes effect after Miloco
  restarts.
- Do not expose the DSH Web UI or `/miloco/webhook` directly to the public
  internet; put them behind a trusted reverse proxy/VPN and TLS.
- Review Miloco's own security model before enabling camera perception.
- Treat model-generated device actions as untrusted: confirm high-risk actions
  (locks, gas, cameras, member deletion) in the UI.
