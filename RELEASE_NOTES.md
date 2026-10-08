### Added
- `sb lint` warns (`UNI001`) about invisible characters in a page, where they can hide an instruction from a reviewer. Captured sources are not checked.
- `sb eval --baseline` also compares each kind of query, and says so when one kind fell while the total did not.
- Optional semantic search (`pip install "sb[vector]"`): `sb index vectors` embeds your pages, `sb search "..." --semantic` ranks by meaning fused with the words (each page is cut in overlapping pieces, so the tail of a long page is found), and `sb eval --semantic --baseline` compares it with the lexical search on your own queries and says which search the baseline was. Off by default: it downloads a model of about 1 GB once and takes about 3 s per command. A hit found only by meaning is marked `(by meaning)`, shows the start of the piece that matched and cites its line. A plain `sb search` is unchanged.
- A `triage` skill: it asks the same four typed questions of every pending source (how relevant, what it would yield, how it overlaps the wiki, whether a person must look first), answers each with a choice, a probability and a confidence, and a fixed policy proposes what to ingest, skip or ask about. It reaches your vault with `sb upgrade`.

### Changed
- A symlink or junction inside a vault is no longer followed: a linked file is not indexed or checked, so a shared vault cannot pull in a file from outside it.
- The session brief marks `memory/hot.md` as notes from earlier sessions, not instructions.
