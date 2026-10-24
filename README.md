<!-- Copyright © 2026 silicastormsiam -->

# Hive PMO

A project management board. One person runs it, an AI team works each stage, and
that person approves.

Built and owned by [silicastormsiam](https://github.com/silicastormsiam).

Version: 1.1.0

![The board with nothing on it](docs/board.png)

That is the board as it greets a new owner: nine empty columns, no accounts, no
sample cards, nothing to sign in to.

## What it is

A work order or a project stands on the board as a card. A card holds its number,
its title, what was asked, what has been proved, what it waits on, and what each
stage run cost.

Nine stages stand on the board:

| Stage | Who works it |
| --- | --- |
| Capture | intake agent |
| Analyse | research agent |
| Approved | the owner |
| Execution | build agent |
| Planning | planning agent |
| Testing | test agent |
| Feedback | review agent |
| Completed | automatic |
| Archive | resting cards |

## Features

- An agent stage runs as a team: one captain that splits the work, and up to four
  workers that do it. The board shows the team while it runs.
- A card moves out of the Approved stage only when the owner moves it. No
  automatic rule acts on that stage.
- Each run writes down what it was asked, the commands it ran, what it changed,
  and its verdict.
- Each run's tokens are counted and priced, so a stage's cost is read beside the
  work it did.
- A card can name what it waits on, and the board holds it until that finishes.
- A background pass reads every live card every 60 seconds and sets aside a run
  that has gone quiet.
- The card's window shows the team at work on it, read from the run's own record.

## Requirements

Docker Engine and Docker Compose. This set is proved with **Docker Engine 29.4.3** and
**Docker Compose v5.1.3**. Those are the versions it was run on, not a demand that a
reader match them exactly.

- **The minimum is Docker Compose v2.** The compose file uses the modern form and
  carries no version key, so Compose v1 cannot read it.
- Nothing else has to stand on the host. The board and its database are two
  containers, and each carries its own runtime: the board's image carries
  **Node.js 24** (node:24-alpine) and runs the server itself, and the database image
  is **PostgreSQL 18** (postgres:18). No Node.js, no PostgreSQL and no separate
  database needs installing on the machine.

Read your own versions and compare:

```sh
docker version --format '{{.Server.Version}}'
docker compose version
```

The first prints the Docker Engine version and the second prints the Compose version.

## Quick start

From nothing to a board answering, in five commands:

```sh
git clone https://github.com/silicastormsiam/Hive-PMO.git
cd Hive-PMO
mkdir -p work
cp .env.example .env
docker compose up -d
```

`mkdir -p work` comes before anything is started on purpose. The compose file mounts
that folder into the board, and if it does not stand there Docker makes it for you,
owned by the system rather than by you, and later writes into it fail.

Now open `.env` and fill in the values. The least you need is a password, used twice:

```
POSTGRES_PASSWORD=choose-a-password
DATABASE_URL=postgresql://hive:choose-a-password@hive-db:5432/hive
```

`hive` in that line is `POSTGRES_USER`, and the last `hive` is `POSTGRES_DB`. If you
change those two, change them here as well.

Start it and watch it come up:

```sh
docker compose up -d
docker compose ps
```

Open the port you set as `PMO_PORT` (3470 unless you changed it) at
`http://127.0.0.1:3470`. You should see the page at the top of this file: the board,
nine columns, no cards, the stage pills across the head.

## Settings

Every setting stands in `.env.example` with a one-line meaning and no values. Copy
it to `.env` and fill it in. This is the whole of them:

| Setting | What it means |
| --- | --- |
| `POSTGRES_DB` | the name of the board's database |
| `POSTGRES_USER` | the account the database runs under |
| `POSTGRES_PASSWORD` | the database's password; the same one goes in `DATABASE_URL` |
| `DATABASE_URL` | the address the board reaches its database on, `postgresql://USER:PASSWORD@hive-db:5432/DB` |
| `PMO_PORT` | the port the board answers on, 3470 by default |
| `PMO_HOME` | where the board keeps its working folder inside the container, `/var/lib/hive`; the read-only work folder is mounted under it |
| `HIVE_REPAIR_ROUNDS` | how many times one card is sent back to be repaired before it stops and waits on its owner, 1 by default |
| `HIVE_HANDS` | how many stage runs may work at the same time |
| `HIVE_HANDS_PER_COLUMN` | the same, within one column |
| `HIVE_QUEEN` | `0` turns the stage worker off entirely |
| `HIVE_QUEEN_SWITCH` | the address the board calls the switch on, `http://host.docker.internal:3471` by default |
| `DSH_BIN` | the harness program the stage worker starts, `dsh` on the PATH by default |
| `DSH_HOME` | the harness home the stage worker reads, `~/.dsh` by default |

Changing a setting takes effect on the next start:

```sh
docker compose up -d
```

## The pieces, and what each one does

| Piece | What it does |
| --- | --- |
| `app/` | the board itself: the page, the server, the cost counter and the watchdog |
| `runner/worker.mjs` | the stage worker: it starts the Queen, hands each card's stages to a team and writes each stage's record |
| `runner/team-bees.patch.yml` | the worker's own settings: the team size and the state folder |
| `queen_switch.py` | a small switch the board calls to start and stop the worker's unit; it answers `GET /state` and `POST /toggle`, `/on`, `/off` on port 3471 |
| `docker-compose.yml` | the two containers: the board and its database |
| `.env.example` | every setting, with no values |
| `VERSION` | the version of this set |
| `docs/board.png` | the picture at the top of this file |

The switch is optional. Without it the board runs, and a card cannot be started or
stopped from the page.

## The agent part, step by step (optional)

The board runs without this. What stops is the work itself: cards still move by
hand, but no agent works a stage, and no run is recorded or priced.

Everything here stands on the same machine as the board.

1. **The harness.** Install the DeepSeek Harness and make sure its program, `dsh`,
   is on the PATH (or name it in `DSH_BIN`). The stage worker reads its home from
   `DSH_HOME`, `~/.dsh` by default.

2. **The team patch.** `runner/team-bees.patch.yml` is the worker's own settings:
   how many members a team may have at once, and where the team's state folder is
   kept. Put it where the harness reads its patches, or name it in the worker's
   environment.

3. **The switch.** Start it in its own unit so it survives a closed window:

   ```sh
   python3 queen_switch.py
   ```

   It answers on port 3471: `GET /state` says whether the worker is running, and
   `POST /toggle`, `POST /on` and `POST /off` start and stop the unit named
   `hive-worker.service`. It allows only the board's own page to call it.

4. **The stage worker's unit.** One systemd user unit, started at login:

   ```ini
   [Unit]
   Description=Hive PMO stage worker

   [Service]
   WorkingDirectory=%h/Hive-PMO
   ExecStart=/usr/bin/node runner/worker.mjs
   Restart=always
   Environment=HIVE_BOARD=http://127.0.0.1:3470
   Environment=DSH_BIN=/usr/local/bin/dsh
   Environment=HIVE_QUEEN_SWITCH=http://127.0.0.1:3471

   [Install]
   WantedBy=default.target
   ```

   Save it as `~/.config/systemd/user/hive-worker.service`, then:

   ```sh
   systemctl --user daemon-reload
   systemctl --user enable --now hive-worker.service
   systemctl --user status hive-worker.service
   ```

5. **Let the board reach the switch.** The board runs in a container, so
   `127.0.0.1` inside it is the container itself. The compose file passes
   `HIVE_QUEEN_SWITCH=http://host.docker.internal:3471` for that reason; keep that
   value unless you move the switch.

## Backup and restore

The data is a PostgreSQL database in the `hive-db` container, written to the `db`
folder beside the compose file.

**Stopping the containers does not touch the data.** `docker compose down` stops
and removes the two containers; the `db` folder and everything in it stays.

Take a backup with a dump:

```sh
set -a; . ./.env; set +a
docker compose exec -T hive-db pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > hive-pmo-backup.sql
```

Restore it into a board with the containers running:

```sh
set -a; . ./.env; set +a
docker compose exec -T hive-db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" < hive-pmo-backup.sql
```

A copy of the whole `db` folder, with the containers stopped, is the second way:

```sh
docker compose down
cp -a db db-backup
docker compose up -d
```

## Upgrade, and reading which version is running

```sh
git pull
docker compose build hive
docker compose up -d --force-recreate hive
docker compose ps
```

Read the version of the files on disk, and the version baked into the running image:

```sh
cat VERSION
docker compose exec hive cat /app/package.json | grep '"version"'
```

The two should agree. When they do not, the container is still the old image: run
the build and the recreate again.

## Troubleshooting

**The port is already in use.** The start fails with
`bind: address already in use`. Change `PMO_PORT` in `.env` to another port, then
`docker compose up -d`. To find what holds the old one:
`ss -ltnp | grep 3470`.

**The database is not ready.** The board's log repeats
`ECONNREFUSED ...:5432`, or the board's container restarts every few seconds. Read
the database's own log: `docker compose logs hive-db`. Two causes are common: the
password in `DATABASE_URL` does not match `POSTGRES_PASSWORD`, or the password was
changed after the database was first made, in which case the database keeps the old
one. Set the two back to the same value, or start again from an empty board.

**A data folder the containers cannot write.** The database's log says
`could not change permissions of directory "/var/lib/postgresql/data"` or
`data directory has wrong ownership`. The database runs as user id 999, and it must
own its folder:

```sh
sudo chown -R 999:999 db
```

The same fault on the work folder shows differently: the board runs, and the team
window stays empty. That folder must belong to you, because the worker writes into
it as you:

```sh
sudo chown -R "$USER":"$USER" work
```

**A stale image after an upgrade.** `cat VERSION` shows the new version and
`docker compose exec hive cat /app/package.json` shows the old one, or the board is
missing something you just added. Build it again and recreate the container:

```sh
docker compose build --pull hive
docker compose up -d --force-recreate hive
```

### Check the download on your own machine

`check.sh` proves this download works where it stands. It reads the compose file,
builds the board, starts it with a throwaway database and a password made on the
spot, waits until the board answers on its health address, and then takes everything
down again.

```sh
./check.sh
```

It needs Docker and curl and nothing else: no account, no key and no permission of any
kind. It uses a project name and a free port of its own, so it never fights a board you
already run, and it leaves nothing behind when it is done.

## Before you put it anywhere: there is no login

The board has no accounts, no passwords of its own and no sign-in. Anyone who can
reach its port can read every card and change anything on it.

Run it on a private network (a home or office LAN, or a VPN), or put it behind
something that logs people in, such as a reverse proxy with authentication. Never
publish it straight to the open internet.

## Start again from an empty board

```sh
docker compose down
rm -rf db
docker compose up -d
```

**This erases every card, every run and every record. There is no undo.** Take a
backup first if anything on the board matters.

## Where the data lives

PostgreSQL 18, in the `hive-db` container, under `./db` beside the compose file.
Stopping the containers does not touch it. A backup is a copy of `./db` or a dump of
the database, as above.

## Remove

```sh
docker compose down
```

The data stays in `./db`. Remove that folder as well and every card goes with it.

## What this is not

- It is not multi-user. There are no accounts, no roles and no sign-in.
- It is not a hosted service. There is no separation between one user's data and
  another's, and it is not built to be exposed to the open internet as it stands.
- It is not a general tracker. Its stages, its gate and its agent teams are the
  shape of the work it was built for.

## Support

Open an issue with the version from `VERSION`, your Docker and Compose versions, the
stage that failed and what the card said. Do not attach a database dump, an `.env`
file, or anything holding a credential.

## Tests

The cost counter carries named tests, and they need no Docker and no install:

```sh
node --test "tests/*.test.mjs"
```

The workflow in `.github/workflows/check.yml` runs them on every push. It can also
run the full check below, from the Actions page, when asked.

`./check.sh` is the slower proof: it builds the board, waits for it to answer, and
takes everything down again.

## Changelog

Every change is written in [CHANGELOG.md](CHANGELOG.md), newest first, with the date
and the version it belongs to.

## Licence

MIT © 2026 silicastormsiam. The licence text stands in
[LICENSE](LICENSE), and the credits for the pieces this code leans on stand in
[LICENCE_AND_CREDIT.txt](LICENCE_AND_CREDIT.txt).
