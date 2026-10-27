# Security

## Reporting

Open a private security advisory on the repository host, or contact the
maintainers directly. Do not file a public issue for a vulnerability that can
control devices, leak tokens, or reach a private camera stream.

## Design boundaries

- **Default read-only.** Write tools are not registered while the plugin runs
  in `readonly` mode. There is no runtime "hidden tool" that the model could
  still call.
- **Webhook fail-closed.** `/miloco/webhook` rejects every request when no
  push token is configured.
- **Token storage.** Connection and push tokens live in
  `$DSH_HOME/miloco-plugin.json` with mode `0600`; they are never returned to
  the browser.
- **Same-origin writes.** Settings mutations reject cross-site `Origin`
  headers.
- **No secrets in the repository.** The project ships no credentials, device
  ids, or Xiaomi account data.
- **No shell interpolation in deployment.** The deployer uses
  `spawn(command, args)`; the repository URL must be `https://`.

## Operational guidance

- Prefer a dedicated Miloco backend token, not your Xiaomi account password.
- Do not expose the DSH Web UI or `/miloco/webhook` directly to the public
  internet; put them behind a trusted reverse proxy/VPN and TLS.
- Review Miloco's own security model before enabling camera perception.
- Treat model-generated device actions as untrusted: confirm high-risk actions
  (locks, gas, cameras, member deletion) in the UI.
