# Personal places map

The page lives at `/places/`, with a link in the site navigation and backlinks
from notes. It builds with Hugo; no paid map API, runtime service, or API key is
needed. Leaflet 1.9.4 is checked into `static/vendor/leaflet/`, including its
license. The map background loads from OpenStreetMap with visible attribution.

## Add a place

In the notebook composer, choose **Save a place**. Search by place name and city,
pick the right result, choose **Liked** or **Saved for later**, and save. Text and
photos are optional. A save without either updates the map without publishing
an empty notebook entry. Location search uses Photon/OpenStreetMap; the source
is attributed in the form. Address and pin fields are available under **Edit
address & pin / add manually** if search misses a venue.

To update somewhere already saved, choose it from the saved-place selector.
You can change its name, kind, status, address, and coordinates, or add a new note
and photos. Selecting a new search result while editing an existing place updates
that place's pin, keeping its ID and older note associations. **Reload places**
reloads the selected place's latest details while keeping your note draft.

The publisher saves the catalog and optional note/photos in one commit. Updates
check the selected place's revision; stale edits are rejected so another window's
changes aren't silently overwritten. Unrelated repository changes are preserved.
The same publishing secret and repository-scoped GitHub token are used. The
`/places` and `/places/search` publisher APIs require authentication. An optional
server-side `PLACES_SEARCH_URL` can point to another compatible Photon instance.

You can also edit `data/places.json` directly. The catalog records the location
and list status; comments and photos come from published notes.

```json
{
  "id": "a-favorite-restaurant",
  "name": "A Favorite Restaurant",
  "aliases": ["A Favorite Restaurant"],
  "category": "Restaurants",
  "status": "saved",
  "city": "San Francisco",
  "neighborhood": "",
  "address": "San Francisco, CA",
  "coordinates": [37.7749, -122.4194],
  "precision": "city",
  "locationNote": "City-level pin until I add the street address."
}
```

Use a stable, unique lowercase `id`. Coordinates are **latitude, longitude**.
Choose `liked`, `saved`, or `mentioned` for the status. Category and city filters
come from the catalog, so new kinds of places and cities appear automatically.
Saved places can exist without notes. `draft: true` hides a catalog entry.

For a confirmed address, use its verified coordinates, `precision: "address"`,
and remove the approximate-location note. `locationSource` can record where you
verified the address. Fellini deliberately uses a city-level pin because the
original note doesn't identify a branch; don't infer an exact venue from it.

## Attach notes and photos

Mention one of a registered place's `aliases` in a note published through the
existing composer. Matching ignores case. Use distinctive names: `Fellini
Coffee` is safer than `Fellini`, which could mean the filmmaker. Matching only
connects known places; it doesn't guess coordinates or invent new venues.

Alternatively, put IDs in a note's front matter:

```yaml
places: ["a-favorite-restaurant"]
```

The composer's place mode adds this field automatically when you include text
or photos. Ordinary note mode still works as before.

This can associate a note with several places. The public map automatically
includes the original note text, its date and permalink, and its Markdown
photos. It shows the latest note on the card, all attached notes in map details,
and all photos in the viewer. Notes link back to their pins. A photo-only note
can use an explicit ID. For a note covering multiple venues, its text and photos
are shared by those pins; split it into separate notes for place-specific photos.

Draft, future-dated, scheduled, and expired notes are excluded from the map even
when Hugo is explicitly building those pages for a preview. Existing text and
photos stay in their original notes. No reviews, ratings, or photos are generated.

This is an independently maintained personal list. It does not connect to or
import private Google Maps likes or saved lists.

## Interaction and verification

City, category, status, and text filters update the list and pins together. Text
search includes original notes. Click a pin or card for details; **Pick a place
for me** chooses from the current results. **Show all pins** restores the overview.
Photo dialogs support Escape and arrow keys. Shared URLs retain selected places
and filters, and browser Back/Forward restores a view. Scrolling over the map
doesn't capture ordinary page scrolling; zoom buttons and touch zoom work.

Without JavaScript, the list, notes, photos, and Google Maps links remain usable.
If map tiles fail, filters and pins continue to work with an explanatory message.

```sh
npm run test:places
npm test --prefix tools/note-publisher
npm run test:runtime --prefix tools/note-publisher
hugo --minify --printPathWarnings
```

Browser checks use Chrome's DevTools endpoint, with no npm browser dependencies.
Start a Hugo preview on port 1314 and a disposable Chrome profile with remote
debugging on port 9233, then run `npm run test:places:browser`. Override
`PLACES_PREVIEW_URL` and `CHROME_DEBUG_URL` to use other ports. The script captures
desktop, mobile, selected-place, and dark-mode screenshots in the system temp
directory. It exercises filters, selection, photo dialogs, sharing, history,
mobile layout, and the no-JavaScript fallback.

`npm run preview:notebook` opens an interactive local composer at
`http://localhost:8788/`, with its map at `/places/`. It automatically signs in
to an isolated preview and holds GitHub writes in memory. It renders an isolated
Hugo copy after a save; your working files and production site are untouched.
Restarting clears preview-only saves. The real publisher keeps its normal sign-in.

The publisher's browser suites (`test:browser` and `test:places-browser`) use
Playwright against the real Worker handler with GitHub and geocoding mocked.
Set `PLAYWRIGHT_MODULE` to an installed Playwright module and optionally set
`CHROME_PATH` to an installed Chrome executable. The places suite covers saves
without notes, updates, photos, location search, draft restoration, stale edits,
and mobile layouts.

During initial QA on this Mac, headless Chrome's external image requests returned
`ERR_INVALID_HANDLE`. The interaction suite passed with the tile-failure fallback;
desktop and mobile screenshots were additionally inspected using real OSM tile
responses fetched by curl with the site's identifying user agent and referrer.
This temporary QA transport is outside the repository; production uses normal
browser tile requests. The Hugo build, Pagefind indexing, places integration tests,
and existing publisher and rendered-site checks passed.

## Design references

- [SF Chronicle diner guide](https://www.sfchronicle.com/project/best-diners-sf-bay-area/):
  synchronized geographic browsing and a readable list, with prominent photos
  and links to individual venues.
- [Mapstr](https://en.mapstr.com/faq): a personal collection with notes, photos,
  and tags. The notebook provides the content rather than a separate review form.
- [Google My Maps](https://www.google.com/maps/about/mymaps/): straightforward pins
  and a shareable collection. Each card opens directly in Google Maps.
- [Felt](https://felt.com/): a generous map canvas and compact controls. Warm paper,
  serif headings, and numbered pins keep this page close to a personal notebook.
