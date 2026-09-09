"""Version tracking for a model folder, through the system `git`.

A model definition is a folder of YAML and CSV, which is what version control
was made for, and Studio's answer to "what did I change?" used to be a 501
saying *use git*. This layer is what lets the app act on that answer: which
files differ from the last commit, what the difference is, committing them,
and reading history — without ever moving the working tree out from under an
open editor. No checkout, no branch switching, no push.

Every call shells out to the `git` on `PATH` rather than taking a library
dependency. The user's own configuration then decides who the author is, how
a commit is signed and which helper reads a credential — the same answers the
terminal beside the browser gets — and a repository this layer cannot read is
one the user's git cannot read either.

A sibling of `modeldef`, `runs` and `results`, and under the same rule: it
imports none of them and is composed only by `server`. Which is why nothing
here resolves an untrusted path — the routes do that through
`modeldef.paths.safe_path` before a path reaches this package.
"""
