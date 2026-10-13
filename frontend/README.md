# Frontend source

Edit files here, then run `node scripts/build-frontend.cjs` from the project root. `index.html` is the generated entry point shared by the browser preview and Electron; do not edit it directly.

`node scripts/preview.cjs` rebuilds on every page request, so refreshing the preview is sufficient after a source edit. Syntax errors stop the build before replacing the last working `index.html`. `node scripts/build-frontend.cjs --check` checks that the generated entry point matches its sources.

- `shell.html` defines the document and template slots.
- `components/` contains the workspace, dialogs and utility overlays, retaining stable DOM IDs for interaction bindings.
- `styles/` separates design tokens, controls, Gantt rendering, dialogs and workspace composition.
- `scripts/` separates project data and dependency analysis, calendar calculations, rendering, interactions, editors, fields, persistence, export, columns and startup.
- `manifest.json` declares CSS and JavaScript order. JavaScript is combined into one classic script so the existing shared lexical state behaves identically in HTTP and Electron `file://` contexts. Put initialization last.
- `assets/` contains local design assets. The preview exposes SVG files from this directory only; Electron packages this directory.

The production build has no runtime module loader and requires no additional packages. Run `node scripts/build-frontend.cjs`, then `node --test test/*.test.cjs` to validate changes when using Node directly. npm start, test and packaging scripts automatically build first.

## Design reference

The interface follows [O02 / 瑞士秩序 (Swiss Order)](https://www.figma.com/design/4DIxwqVL8mX0M9iJfj0j80/?node-id=155-131) from the user-supplied visual style library. Its overview, button, table row, breadcrumb, select, badge and text-field components inform this implementation. The working layout adapts those components to the scheduling application: a numbered navigation rail, project overview, divided work surface and task details drawer.

The core palette is white and `#f4f4f2`, with `#151719` primary text, `#58616c` secondary text, `#155eef` action blue and `#d0d3d5` dividing lines. Flat surfaces, square corners, visible grid alignment and 40 px controls establish the visual hierarchy. Keyboard focus remains a distinct interaction state. The native font stack includes the reference families when installed and local fallbacks; no remote font request is required.

`assets/chevron.svg` is the exported O02 chevron. Its supplied Lucide ISC and Feather MIT notices are retained verbatim in `assets/LICENSE.txt`, with the component provenance. This attribution describes that asset; it does not assign a license to the entire Figma library.

## Workspace behavior

- The navigation rail and work-surface tabs switch between the Gantt schedule and a full-width task table. Both use the same project, filters, selection, fields and editing logic. Switching views does not copy or migrate task data.
- Project File groups JSON import, JSON export and PNG export. The split New Task control exposes pipelines, subtasks, important nodes and timeline milestones. Menus support keyboard navigation, Escape and focus return; the main task-creation action remains directly visible.
- The project heading shows its editable name, date range, task count, milestone count and weighted progress. Pipeline links locate existing rows. Filtering and selected-task actions sit above the work surface.
- Double-clicking a task opens its right-hand details drawer. Basic information, dates, progress, custom fields and dependencies remain sections of the same editor. The field manager separates existing columns from field creation; settings and help remain dedicated dialogs.
- Column widths are fixed and independent. Dragging a column-header boundary changes only that column, following pointer movement one-to-one within its width limits. Double-clicking the boundary fits the currently visible content. Columns and Fields offers Restore Default Column Widths instead of the previous name auto-fill checkbox.
- The table pane initially targets about 40% of the work-surface width, capped at 576 px and aligned to a default column boundary when space permits. This starting allocation is independent of later column edits. Dragging the central divider stays continuous and changes the pane only, preserving every column width. Double-click the divider or select Reset Proportion to restore the default allocation; this does not reset column widths.
- Table and timeline scroll horizontally independently, with synchronized vertical movement and one visible vertical scrollbar at the far right. The name column stays pinned when there is sufficient room; a narrow pane allows it to scroll so other fields remain reachable. The Add Field action opens field creation.

`scripts/app-shell.js` controls navigation, menus and project overview presentation. Scheduling rules, dependency analysis, persistence, undo/redo and drawing stay in their respective feature modules. Stable DOM IDs let the shell reorganize controls without changing the underlying command bindings.

## Layout state and migration

`meta.layoutVersion: 2` identifies the independent-width model. `meta.cols` stores individual column widths. `meta.paneAuto` selects the responsive default pane allocation; a manual divider adjustment sets it to `false` and stores the preferred pane width in `meta.lw`. The current viewport constrains the rendered pane without using that pane width to stretch or shrink columns. Reset Proportion restores automatic pane allocation, while Restore Default Column Widths resets columns separately.

Opening a project with the older layout migrates its width settings to the new defaults. This resets layout widths only: tasks, dependencies, custom field definitions and values, column order and visibility remain intact. The previous name-column auto-fill preference no longer controls layout.

This interaction model draws on [DHTMLX's independent grid and column sizing](https://docs.dhtmlx.com/gantt/api/config/grid_elastic_columns/), its [separate horizontal and shared vertical scroll layout](https://docs.dhtmlx.com/gantt/guides/layout-config/), and Syncfusion's [pane positioning](https://ej2.syncfusion.com/javascript/documentation/gantt/splitter) and [column resizing and content fit](https://ej2.syncfusion.com/javascript/documentation/gantt/columns/column-resizing). The 40% / 576 px default is this application's design choice, rather than a universal setting prescribed by those libraries.
