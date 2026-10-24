# Notes for the next reader of this folder

This folder is the whole board. It is published as silicastormsiam/Hive-PMO.

## What stands where

- app/ - the board: the page, the server, the cost counter and the watchdog.
- runner/ - the stage worker and its own settings.
- queen_switch.py - the switch the page calls to start and stop the worker.
- docker-compose.yml - the two containers: the board and its database.
- check.sh - the check that builds the board, proves it answers, takes it down.
- tests/ - named tests for the cost counter.
- VERSION - the version of this set.
- CHANGELOG.md - what changed, and when.

## What to run

    cp .env.example .env      fill in the password, in two places
    docker compose up -d
    ./check.sh                the board from nothing, then taken down again
    node --test "tests/*.test.mjs"     the cost counter's tests, no Docker needed

## Two things worth knowing

- There is no login. Anyone who reaches the port can read and change every card.
  Keep it on a private network, or behind something that logs people in.
- The version must agree in three places - VERSION, the read-me and
  app/package.json - before a release. The publisher stamps all three.
