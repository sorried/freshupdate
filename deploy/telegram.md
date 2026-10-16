# tgcloud deployment

Telegram updates reach the handlers in `freshupdbot/tgcloud/handlers/`, then pass
to `https://telegram.exteragram.xyz/updates` using a shared bearer secret.
The server stores subscribers and runs release polling every 300 seconds.

The backend runs as `freshupdate-api.service` under the `freshupdate` account.
Application files are in `/opt/freshupdate`, SQLite is in
`/var/lib/freshupdate/bot.db`, and root-only configuration is in
`/etc/freshupdate/api.env`. The API binds to `127.0.0.1:18754` behind nginx.

```sh
ssh cat 'sudo systemctl status freshupdate-api.service'
ssh cat 'sudo journalctl -u freshupdate-api.service -n 50'
```

Build with `npm run check` before uploading `dist/` and restarting the service.
Deploy cloud handlers from `freshupdbot` with `npm run deploy`.
The existing `freshupdbot` ignore rule protects the generated credentials module
and CLI state. Never commit or print their contents. Rotate the API secret in
both `/etc/freshupdate/api.env` and the cloud credentials module together.

The dedicated certificate is renewed by certbot. nginx serves only the exact
`POST /updates` route over HTTPS, with authentication, body and rate limits.
Other paths return 404, and requests without valid authentication return 401.
Do not run the polling entry point `dist/main.js` for the same bot while the
cloud webhook is enabled.

The copied `import.db` is a private snapshot of the original subscriber database.
Only subscriber rows were merged into the live database to avoid overwriting
registrations received during deployment. The live database owns the release
baseline and delivery queue.
