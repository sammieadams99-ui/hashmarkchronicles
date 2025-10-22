# Hashmark Chronicles Data Schemas

## Team Roster

`/data/team/roster.json` is an array of player objects for the current season.

```json
{
  "id": 5141378,
  "name": "Cutter Boley",
  "number": 12,
  "pos": "QB",
  "class": "FR",
  "height": "6-5",
  "weight": 220
}
```

* `id` is the **ESPN athlete id** and is required for every row.
* `name` and `pos` are required strings.
* `number`, `class`, `height`, and `weight` are optional and may be omitted when unavailable.

`/data/team/roster_plus.json` extends the same player array and includes lookup maps for debugging:

```json
{
  "players": [...],
  "byId": {
    "5141378": { "id": 5141378, "name": "Cutter Boley", "pos": "QB" }
  },
  "byName": {
    "cutter boley": { "id": 5141378, "name": "Cutter Boley", "pos": "QB" }
  },
  "meta": {
    "teamId": 96,
    "team": "Kentucky",
    "season": 2025
  }
}
```

Both roster files MUST contain numeric ESPN ids for at least 90% of rows. Builds fail when the roster size falls outside 65–150 players.

## Spotlight Datasets

All spotlight datasets live at the repo root under `/data/spotlight_*.json`.

* `spotlight_offense_last.json`
* `spotlight_defense_last.json`
* `spotlight_offense_season.json`
* `spotlight_defense_season.json`
* `spotlight_featured.json` (single object)

Each spotlight entry MUST include an ESPN id and link so the client can derive headshots and stats.

```json
{
  "id": 5141378,
  "name": "Cutter Boley",
  "pos": "QB",
  "espn": "https://www.espn.com/college-football/player/_/id/5141378/cutter-boley",
  "last_game": {
    "opp": "Texas",
    "cmp_att": "31/39",
    "yds": "258",
    "td": "0",
    "int": "1"
  }
}
```

* `id` must be numeric and match an entry in the roster.
* `espn` should always be the canonical ESPN player URL; ids may be parsed from it during validation.
* At least one of `last_game` or `season` must be a non-empty object of string stats.
* Builds fail when more than 5% of spotlight ids are missing from the roster or when any entry lacks an id/link pair.

## Cache Hygiene

A successful build writes a `spotlight_history.json` metadata file and mirrors the most recent artifacts into `.cache/spotlight/last-good/`. Use `npm run validate:data` to confirm datasets before publishing.
