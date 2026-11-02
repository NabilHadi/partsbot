# Bot API contract pairs (shared with PartsBot)

One JSON file per row of the contract table (bot spec section 7, C1-C20):
`{ id, title, expected, request, response }`. PartsBot's client tests parse
each `response.body` with its zod schemas and assert `expected`.

Placeholders stand where real values would leak or vary: `<VIN_LC>`,
`<VIN_AMBIGUOUS>`, `<VIN_UNKNOWN>`, `<VIN_BMW>`, `<PN_*>` (part numbers),
`<VEHICLE_ID>`, `<DIAGRAM_ID>`, `<REQUEST_ID>`, `<DATA_VERSION>`,
`<REMAINING>`. A request path keeps its Arabic query percent-encoded.

Generated, not hand-written: `tests/unit/bot-toyota-routes.test.js` runs
the real router over a seeded Toyota GR region (a Land Cruiser directory,
the JOHOVN VIN table, joho Specifications) and, with
`BOT_CONTRACT_WRITE=1`, rewrites these files:

```bash
npm run build:backend && BOT_CONTRACT_WRITE=1 node --test tests/unit/bot-toyota-routes.test.js
```

The fixture is synthetic, with real catalog names and real Arabic name-file
entries, so no catalog data is committed. Regenerating from a live release
on a dev machine needs only different VINs and placeholders in that test.
