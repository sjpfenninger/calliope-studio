# Changelog

## 0.2.0 (unreleased)

New features:

- Model and scenario comparison view
- Improved config model and schema widgets
- Tabs visibly show if they are running a background task
- Hovering on a per-node "Totals" bar highlights the node in the map view

Fixes:

- Prevent loss of unsaved edits on tab switching, closing, reload and model switch
- Refuse saving if a file changed on disk since having been loaded
- Saving is disabled on a clean form
- Any file can be edited in only one pane at a time
- Section writes better preserve anchors, number spellings, comments, line endings, byte-order marks, indentation and integer keys
- Confine writes to the model definition and reject path traversal
- Order run retention by request time rather than file dates
- Make data tables more robust
- Removing a technology, node, link, data table, scenario or override asks first
- Sidebar width, the nodes/links List/Map choice and the link template are remembered
- Time series zoom survives other plot option selections
- Renaming a technology, link, node, data table or scenario doesn't move it in the file
- Various other UI fixes
- Better UI testing, browser checks included in frontend test coverage

## 0.1.2 (2026-09-02)

- Allow opening runs by clicking anywhere in a run row
- Correctly bundle third party licenses

## 0.1.1 (2026-09-01)

- Adapted to the Calliope 0.7.0 release
- Python 3.14 is now supported

## 0.1.0 (2026-08-27)

Initial release of Calliope Studio, a browser-based interface for [Calliope](https://calliope.readthedocs.io/) (version 0.7 and later).
