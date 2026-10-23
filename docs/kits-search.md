# Find saved kits

The Kits and equipment screen searches names and notes across every saved kit, ignoring case and accents. All search words must match. The web list shows ten kits per page; Previous and Next reach the rest. The count refers to the current search.

Changing the search or page keeps the open editor and its unsaved fields. In combination mode, selected kits retain their names and a Remove action even when they are outside the visible page. A partial or filtered page never proves that a selected kit was deleted. Checking a combination still reads the current saved definitions and stock, and accepts at most fifty kits. If a selected definition no longer exists, remove it from the selection after the check reports the error.

`home_kits` keeps its existing list/get/save/delete actions. For `action=list`:

- `q`: optional text, up to 200 characters, searched in name and notes.
- `offset`: nonnegative integer, default zero.
- `limit`: integer from one to fifty, default fifty.
- Response: `kits`, filtered `total`, `all_total` active saved kits, `q`, `offset`, `limit`, `has_more`.

Results are ordered by folded name and then ID. Each call reads the current local state; edits between pages can change their contents. Listing, filtering and paging change no inventory, definitions or versions. API and MCP use the same native operation; the catalogue still contains nineteen tools.

The feature is verified on web desktop and a narrow browser viewport. Shared TypeScript is checked, but this change does not claim a native Android or iOS device run.
