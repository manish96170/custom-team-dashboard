# Redaction notice

Before this repository was made public, two mechanical substitutions were applied to every file in this
directory:

- absolute paths → `/path/to/…` (the OS username and the workspace directory name are removed)
- the OS username → `user`

**Nothing else was altered.** No event, timing, status, exit code, token count, or captured payload was
changed, added or removed. The substitutions touch only path strings and an owner column — including where a
path appears split across streamed token deltas, which is why some JSON fragments read oddly at the seam.

The evidence's purpose is the *mechanism* it captured (permission modes, stream shapes, process lifecycle), and
that is untouched. If you are diffing against your own run, expect the paths to differ and nothing else to.
