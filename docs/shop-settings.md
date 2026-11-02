# Per-shop settings

Stored in `shops.config` (jsonb), validated by `shopConfigSchema` in `src/bot/shop-config.ts` (strict: unknown keys
are rejected). Only the keys a shop chose are stored; everything else uses the default in code. If a stored config
does not validate, the worker does NOT reply for that shop and logs a critical `shop_config_invalid` alert (paths only).

| key | values | default | effect |
|---|---|---|---|
| `priceQuotingEnabled` | bool | `false` | show the shop's prices from its stock list (VAT note added) |
| `showPartNumbers` | bool | `true` | `false`: the part is named only ("القطعة المناسبة لسيارتك"); the number is logged for staff (`parts_identified` event, `state.lastParts`), never shown |
| `stockDisplay` | `hidden` / `availability` / `quantity` | `availability` | `hidden`: no stock lines (no lookup at all unless prices are on); `availability`: متوفر / غير متوفر; `quantity`: متوفر (4) |
| `showAlternatives` | bool | `true` | list the shop's suffix variants (J ياباني, CH صيني, DENSO...) under the exact number |
| `language` | `ar` / `en` / `auto` | `ar` | `auto` follows the customer's language |
| `businessHours` | per weekday, up to 4 windows `HH:MM-HH:MM` | Sat–Thu 09:00–22:00, Fri 16:00–22:00 (Asia/Riyadh) | `close <= open` runs past midnight (e.g. `16:00-02:00`); `24:00` allowed as a close; overlaps rejected |
| `afterHoursMode` | `reply_with_note` / `note_only` | `reply_with_note` | closed: answer normally + one "⏰ closed, staff follow up <when>" note per closed period; or send only that note (once) and wait for staff |
| `staff` | up to 10 `{name, phone}` | `[]` | handoff staff `{name, phone, notify}`; `phone` stored as normalized E.164 (no field encryption for now). Shown/logged only masked (last 4 digits), never to customers, never sent to OneEPC. Stored only; notifications come later |
| `staffHandoffName` / `staffHandoffPhone` | text | `""` | the PUBLIC shop name/number the bot may tell customers |
| `testShop` / `allowSyntheticStock` | bool | `false` | synthetic stock is shown only when both are true |
| `shopName`, `stockStaleDays`, `maxBotMessagesPerDay`, `sessionTtlMinutes`, `handoffSilenceMinutes`, `maxPartsPerReply` | | `""`, 7, 40, 120, 720, 3 | |

## CLI

```
npm run shop -- list
npm run shop -- show <shop-id>                          # effective config, staff numbers masked
npm run shop -- create --name "<name>" [--city ..] [--zernio-account ..] [--waba ..] [--plan ..] [--test]
npm run shop -- set <shop-id> showPartNumbers=false stockDisplay=quantity showAlternatives=false [--dry-run]
npm run shop -- set <shop-id> "hours.fri=08:00-12:00,16:00-23:00" hours.thu=16:00-02:00 afterHoursMode=note_only
npm run shop -- unset <shop-id> showPartNumbers hours.fri   # back to defaults ("hours" = whole week)
npm run shop -- status <shop-id> active|paused|closed
npm run shop -- staff-add <shop-id> --name "أبو فهد" [--no-notify]     # prompts for the number
printf '05XXXXXXXX' | npm run shop -- staff-add <shop-id> --name "أبو فهد"   # or pipe it on stdin
npm run shop -- staff-remove <shop-id> --name "أبو فهد"
```

Needs `DATABASE_URL`. `staff-add` never takes the number as an argument (`--phone` is rejected: argv shows up in
`ps` and shell history); it reads it from stdin or an interactive prompt, normalizes it to E.164 and prints it masked.
