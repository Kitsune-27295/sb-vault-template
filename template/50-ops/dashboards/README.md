This folder holds three Bases dashboards (`.base` files). They need no plugin beyond Obsidian's core Bases plugin.

- `active-concepts.base`: concepts in `40-compiled/` with `status: active`.
- `pending-proposals.base`: proposals in `30-proposals/` with `status: draft`.
- `overdue-procedures.base`: active procedures in `40-compiled/` whose `review_by` date is before today.

Set the sort once. The dashboards ship without a sort because the `.base` key that stores a view's sort is not documented (ADR 0004). Open each dashboard, then use the **Sort** menu in the view toolbar: sort "Active concepts" by `updated` descending, "Pending proposals" by `created` ascending, and "Overdue procedures" by `review_by` ascending. Obsidian saves the choice into the `.base` file itself.

The filters use the frontmatter fields defined in `90-system/schema/note-schema.yaml`. If a dashboard looks empty, check that notes carry `type`, `status` and, for procedures, `review_by`; `sbk doctor` reports notes that do not.
