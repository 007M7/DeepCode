# Recall batteries

Probes for [the taxonomy](../SKILL.md#taxonomy), tuned during the 2026-08 purge. Every hit needs semantic judgment — the batteries over-match by design, and they under-match by nature: each review round of the purge found shapes no battery caught, so pair them with an unpatterned read of the densest prose in scope.

## Invocation rules

- Add `--hidden --glob '!.git/**'` so `.agents/` is searched; ripgrep skips dot-directories by default and the purge's biggest miss risk was Agent Notes.
- Exclusions go last so a later include cannot re-admit them: `--glob '!vendor/**' --glob '!node_modules/**' --glob '!.agents/notes/archived/**' --glob '!.agents/skills/dsh-trim-cot-leakage/references/**'` (this directory quotes leaked shapes as calibration), plus recorded fixture and snapshot directories in scope.
- A zero-hit pattern proves nothing until you have seen it match: test it against a known-positive string before trusting the negative.

## English battery

```sh
rg -n --hidden '\(decision \d|\(audit [A-Z]\d|design §|plan §|design ledger|\(B ruling|\bP-I\b|\bW\d\b|\bT\d\b' ...
rg -n --hidden 'this PR|this branch|this stack|later PR|previous commit|this commit' ...
rg -n --hidden 'used to |no longer|previously|the old |was renamed|was moved' ...
rg -n --hidden '\bv1\b|this cut|\bcut \d|\btoday\b|\bfor now\b|roadmap' ...
rg -n --hidden -i 'rejected in review|review round|reviewer|as of v\d' ...
rg -n --hidden 'probably |should be enough|should suffice|it simply|is safe —|is safe --' ...
rg -n --hidden '§\d' ...
```

## Chinese battery

```sh
rg -n --hidden '设计稿|评审|上一?轮|旧版|老的|不再|以前|本版|遗留|私有' ...
rg -n --hidden '(^|[^a-zA-Z])端([^a-zA-Z]|$)' --glob '*.md' ...
```

## Known false-positive families

Judged and kept during the purge; expect them again:

- **Instrumental "used to"** — "the key used to sign requests" is instrumental, not temporal. The temporal form has a subject state before it ("colors used to come from…").
- **Runtime old/new** — "the old connection drains before the new one accepts" names live objects during handover, not repo states.
- **"This PR" in process docs** — documentation *about* PR workflow ("the PR body should…", templates, this repo's process notes) legitimately says "PR"; the ban is on a doc adopting one PR's vantage about the code.
- **`v1` as protocol or path segment** — `/v1/chat` endpoints and wire-format names are identifiers, not version stamps.
- **`§N` with a committed owner** — external standards (RFC 9110 §10.1.5) and committed docs that own their §-numbering stay citable by section.
- **Contrastive "actually" and noun "wait"** — ordinary English, not hedging.
- **"Today" in generated timestamps and CLI output samples** — recorded output keeps its voice.
- **本版本 in zh prose** — a legitimate rendering of "this release" in versioned-artifact contexts; the banned indexical is 本版 as a bare stamp mirroring "this cut".
- **Alternatives-considered sections** — "rejected" inside an Agent Note's genre slot is the sanctioned home, not review choreography.
