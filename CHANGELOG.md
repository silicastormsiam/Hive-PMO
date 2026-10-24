# Changelog

Every notable change to this project is written here, newest first. The form is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the versions are this
project's own release tags.

## [1.1.0] - 2026-10-24

### Added
- A changelog, this file, so the history of the board is read in the download and
  not only on the releases page.
- AGENTS.md, a short note telling the next person - or the next agent - which folder
  does what and what to run.
- tests/costs.test.mjs, named tests for the cost counter, run with one command.
- .github/workflows/check.yml, which runs those tests on every push and can run the
  full board check when asked.
- The licence is declared in the package manifest.

### Changed
- The version is stated once and carried to the read-me and the manifest by the
  release itself.

## [1.0.6] - 2026-10-24

### Added
- check.sh, the check a reader runs: it builds the board on their own machine,
  proves it answers, and takes it down again.

## [1.0.5] - 2026-10-24

### Changed
- The read-me rewritten for a reader who has never seen the board.

## [1.0.4] - 2026-10-24

### Changed
- The picture of an empty board, at the head of the read-me.

## [1.0.2] - 2026-10-24

### Added
- First published set: the board, its database, the stage worker and its switch.
