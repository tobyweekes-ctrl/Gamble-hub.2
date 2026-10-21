#!/bin/sh
# Downloads match results and stats (football-data.co.uk) into data/raw/.
# Seasons: the five before the current one plus the current one. Re-run weekly.
set -e
cd "$(dirname "$0")/../.."
mkdir -p data/raw
for s in 2122 2223 2324 2425 2526 2627; do
  for d in E0 E1 E2 D1 D2 I1 I2 F1 F2; do
    curl -sSfL -m 60 -o "data/raw/$d-$s.csv" "https://football-data.co.uk/mmz4281/$s/$d.csv"
  done
done
echo "fetched $(ls data/raw/*.csv | wc -l) files"
