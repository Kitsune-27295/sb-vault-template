### Added
- `sb clip` captures the code examples of pages that draw them with JavaScript (documentation with an interactive editor, such as Mermaid's), using the Edge or Chrome already installed. It is the opt-in extra `python setup-sb.py --extra render`; without it such a page now fails with that instruction instead of being captured without its examples (ADR-033).

### Changed
- A captured page's links are cleaned: heading anchors, `#fragment` and self links and tracking parameters are removed, and relative links of a web page become absolute (an imported export keeps its relative links). Addresses with parentheses, code blocks and images are untouched, and a query string is only rewritten when a tracker leaves it (ADR-033). A folder you imported before is still `unchanged` on the next `sb import`.

### Fixed
- `setup-sb.py` takes `--extra render` and `--extra vector`, and an update keeps them. Until now a vault had no way to install either extra, and the messages sent you to a command that only works in a source checkout.
