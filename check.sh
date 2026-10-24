#!/usr/bin/env bash
# THE CHECK THAT RUNS ON YOUR OWN MACHINE.
# It builds the board from this download, proves it starts and answers, then takes
# everything it made down again. It needs Docker, curl and this folder: no account, no
# key and no permission of any kind.
#
#   ./check.sh
#
# It uses its own compose project name and its own free port, and it writes nothing
# into this folder that it does not take away again.

set -euo pipefail

project="hive-check"
port=""
env_file="$(mktemp)"
override_file="$(mktemp)"
made_work=0
step=0

say() {
  step=$((step + 1))
  echo
  echo "step ${step} of 8: $*"
}

compose() {
  docker compose --project-directory . -f docker-compose.yml -f "${override_file}" \
    --env-file "${env_file}" -p "${project}" "$@"
}

# The compose file asks for values it needs before any of ours stand, so these two
# steps carry throwaway ones of their own.
compose_with_placeholders() {
  PMO_PORT="${port}" POSTGRES_DB=hivecheck POSTGRES_USER=hivecheck \
  POSTGRES_PASSWORD=config-check-only \
  DATABASE_URL="postgresql://hivecheck:config-check-only@hive-db:5432/hivecheck" \
    docker compose --project-directory . -f docker-compose.yml \
      -f "${override_file}" -p "${project}" "$@"
}

cleanup() {
  status=$?
  trap - EXIT
  echo
  if [ "${status}" -ne 0 ]; then
    echo "taking everything down"
  fi
  compose down -v --rmi local >/dev/null 2>&1 || true
  if [ "${made_work}" = "1" ]; then
    rmdir work 2>/dev/null || true
  fi
  rm -f "${env_file}" "${override_file}"
  left="$(docker ps -a --filter "name=${project}" --format '{{.Names}}' || true)"
  if [ -n "${left}" ]; then
    echo "something of the check is still standing: ${left}" >&2
  else
    echo "nothing of the check is left behind"
  fi
  if [ "${status}" -ne 0 ]; then
    echo "the check did not pass (exit ${status})" >&2
  fi
  exit "${status}"
}
trap cleanup EXIT

# A free port, so the check never fights the board you already run.
for try in $(seq 3470 3499); do
  if ! (exec 3<>"/dev/tcp/127.0.0.1/${try}") 2>/dev/null; then
    port="${try}"
    break
  fi
done
port="${port:-3470}"

# The two containers get names of their own, so the check never fights a board that
# is already running on this machine, and the database writes to a throwaway volume
# that is destroyed with everything else at the end.
cat > "${override_file}" <<'YAML'
services:
  hive-db:
    container_name: hive-check-db
    volumes:
      - hive-check-data:/var/lib/postgresql/data
  hive:
    container_name: hive-check

volumes:
  hive-check-data:
YAML

echo "the check that runs on this machine, on port ${port}"

say "reading the compose file as configuration"
compose_with_placeholders config --quiet
echo "the compose file reads"

say "building the board's image"
compose_with_placeholders build hive
echo "the image is built"

say "writing a throwaway settings file"
password="$(openssl rand -hex 16)"
{
  echo "POSTGRES_DB=hivecheck"
  echo "POSTGRES_USER=hivecheck"
  echo "POSTGRES_PASSWORD=${password}"
  echo "DATABASE_URL=postgresql://hivecheck:${password}@hive-db:5432/hivecheck"
  echo "PMO_PORT=${port}"
  echo "PMO_HOME=/var/lib/hive"
  echo "HIVE_REPAIR_ROUNDS=1"
  echo "HIVE_HANDS=2"
  echo "HIVE_HANDS_PER_COLUMN=1"
  echo "HIVE_QUEEN=0"
} > "${env_file}"
echo "the settings are in a throwaway file, with a password made on the spot"

say "making the work folder first"
if [ -d work ]; then
  echo "the work folder already stands"
else
  mkdir -p work
  made_work=1
  echo "the work folder is made"
fi

say "bringing the two containers up"
compose up -d
echo "the two containers are up"

say "waiting for the database to report healthy"
database=""
for attempt in $(seq 1 60); do
  database="$(compose ps -q hive-db 2>/dev/null || true)"
  state="$(docker inspect -f '{{.State.Health.Status}}' "${database}" 2>/dev/null || echo unknown)"
  if [ "${state}" = "healthy" ]; then
    echo "the database reported healthy after ${attempt} ask(s)"
    break
  fi
  if [ "${attempt}" = "60" ]; then
    echo "the database never reported healthy" >&2
    compose ps || true
    compose logs hive-db || true
    exit 1
  fi
  sleep 2
done

say "asking the board until it answers"
answered=0
for attempt in $(seq 1 60); do
  if body="$(curl -fsS -m 3 "http://127.0.0.1:${port}/health" 2>/dev/null)"; then
    echo "the board answered after ${attempt} ask(s): ${body}"
    answered=1
    break
  fi
  if [ "${attempt}" = "60" ]; then
    echo "the board never answered on its health address" >&2
    compose ps || true
    compose logs hive || true
    exit 1
  fi
  sleep 2
done
if [ "${answered}" != "1" ]; then
  echo "the board never answered" >&2
  exit 1
fi

say "taking everything down"
compose down -v --rmi local
echo "the check passed: the download built, the board answered, and everything is down"
