"""
Storage on Tiger Data (Postgres + TimescaleDB).

- games: one row per game, the whole state as JSONB (see game.new_game for its shape)
- shots: one row per shot ever taken, a TimescaleDB hypertable. This is the coach's
  long-term memory: player_stats() turns it into make rates by cut angle, shot type and
  pocket, and a weekly trend, which go into the Gemini prompt.

Works on plain Postgres too (local testing): without the timescaledb extension, shots is a
normal table and the weekly trend uses date_trunc instead of time_bucket.
"""
import os
import threading

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from game import GameError

_conn: psycopg.Connection | None = None
_timescale = False
_lock = threading.Lock()

SCHEMA = """
create table if not exists games (
    id text primary key,
    state jsonb not null,
    updated_at timestamptz not null default now()
);
create table if not exists shots (
    t timestamptz not null default now(),
    game_id text not null,
    player text not null,          -- lowercased name: the same player across games
    target int,                    -- the ball they meant to pocket (null if unknown)
    pocket text,
    kind text,                     -- 'direct' | 'bank'
    cut_angle real,
    made boolean,                  -- target went in (null if no intended target)
    pocketed int[] not null,
    scratch boolean not null,
    coached boolean not null,      -- they asked the coach first
    speed text,
    spin text,
    photo int,                     -- the photo that showed this shot's result
    power real,                    -- coached strike: power 0-1, spin -1..1 (null if not coached)
    spin_x real,
    spin_y real
);
alter table shots add column if not exists photo int;
alter table shots add column if not exists power real;
alter table shots add column if not exists spin_x real;
alter table shots add column if not exists spin_y real;
create index if not exists shots_player_t on shots (player, t desc);
"""


class StoreError(Exception):
    """The database isn't reachable or configured. Message is shown to the user."""


def _connect() -> psycopg.Connection:
    global _conn, _timescale
    if _conn is not None and not _conn.closed and not _conn.broken:
        return _conn
    url = os.getenv("DATABASE_URL", "")
    if not url or "your-" in url:
        raise StoreError("The game database isn't set up: put your Tiger Data service URL "
                         "in backend/.env as DATABASE_URL.")
    try:
        conn = psycopg.connect(url, autocommit=True, row_factory=dict_row, connect_timeout=10)
        conn.execute(SCHEMA)
        try:
            conn.execute("create extension if not exists timescaledb")
            conn.execute("select create_hypertable('shots', 't', if_not_exists => true, "
                         "migrate_data => true)")
            _timescale = True
        except psycopg.Error:
            _timescale = False   # plain Postgres: everything still works
    except psycopg.Error as e:
        raise StoreError(f"Couldn't reach the game database: {e}") from e
    _conn = conn
    return conn


def _run(*statements: tuple[str, tuple]):
    """
    Execute statements on the shared connection, all-or-nothing (one transaction).
    Returns the last statement's cursor. The lock keeps statements from different
    requests from interleaving inside a transaction.
    """
    global _conn
    with _lock:
        for attempt in (1, 2):   # a dropped connection gets one retry
            try:
                conn = _connect()
                with conn.transaction():
                    for sql, params in statements:
                        cur = conn.execute(sql, params)
                return cur
            except psycopg.OperationalError as e:
                _conn = None
                if attempt == 2:
                    raise StoreError(f"Couldn't reach the game database: {e}") from e
            except psycopg.Error as e:   # the transaction rolled back; nothing was saved
                raise StoreError(f"The game database rejected that ({type(e).__name__}).") from e


# ------------------------------------------------------------------ games
def load_game(game_id: str) -> dict:
    row = _run(("select state from games where id = %s", (game_id,))).fetchone()
    if row is None:
        raise GameError("That game doesn't exist (or was deleted). Start a new one.")
    return row["state"]


_SAVE_GAME = """insert into games (id, state) values (%s, %s)
                on conflict (id) do update set state = excluded.state, updated_at = now()"""


def save_game(state: dict) -> None:
    _run((_SAVE_GAME, (state["_id"], Jsonb(state))))


# ------------------------------------------------------------------ shots
def save_photo(state: dict, shot: dict | None, undone: dict | None = None) -> None:
    """
    Save the game after a photo, together with what it changed in the shot history:
    the shot it showed (game.process_photo's event), and, for a correction, removing the
    shot the replaced photo had shown. All in one transaction, so the stats never
    disagree with the game.
    """
    statements = [(_SAVE_GAME, (state["_id"], Jsonb(state)))]
    if undone is not None:
        statements.append(("delete from shots where game_id = %s and photo = %s",
                           (state["_id"], undone["photo"])))
    if shot is not None:
        intended = shot.get("intended") or {}
        statements.append((
            """insert into shots (game_id, player, target, pocket, kind, cut_angle, made,
                                  pocketed, scratch, coached, speed, spin, photo,
                                  power, spin_x, spin_y)
               values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (state["_id"], shot["player"].strip().lower(), intended.get("target"),
             intended.get("pocket"), intended.get("kind"), intended.get("cut_angle"),
             shot.get("made"), shot["pocketed"], shot["scratch"], bool(shot.get("coached")),
             intended.get("speed"), intended.get("spin"), shot.get("photo"),
             intended.get("power"), intended.get("spin_x"), intended.get("spin_y"))))
    _run(*statements)


CUT_BUCKETS = "case when cut_angle < 15 then '0-15' when cut_angle < 30 then '15-30' " \
              "when cut_angle < 45 then '30-45' else '45+' end"


def _rates(rows: list[dict], key: str) -> dict:
    return {r[key]: {"attempts": r["attempts"], "made": r["made"],
                     "rate": round(r["made"] / r["attempts"], 2)} for r in rows if r["attempts"]}


def player_stats(name: str, days: int = 90) -> dict:
    """
    How this player actually shoots, from every shot they've taken in the last `days`.
    Only shots with a known intended target count toward make rates.
    """
    p = name.strip().lower()
    window = "player = %s and t > now() - make_interval(days => %s)"
    base = _run((f"""select count(*) as shots,
                           count(*) filter (where target is not null) as attempts,
                           count(*) filter (where made) as made,
                           count(*) filter (where scratch) as scratches,
                           count(distinct game_id) as games
                    from shots where {window}""", (p, days))).fetchone()

    def by(expr: str) -> list[dict]:
        return _run((f"""select {expr} as k, count(*) as attempts, count(*) filter (where made) as made
                         from shots where {window} and target is not null
                         group by 1 order by 1""", (p, days))).fetchall()

    bucket = "time_bucket('1 week', t)" if _timescale else "date_trunc('week', t)"
    weekly = _run((f"""select {bucket} as week, count(*) as attempts,
                             count(*) filter (where made) as made
                      from shots where {window} and target is not null
                      group by 1 order by 1 desc limit 6""", (p, days))).fetchall()
    return {
        "player": name.strip(),
        "games": base["games"],
        "shots": base["shots"],
        "attempts": base["attempts"],
        "made": base["made"],
        "make_rate": round(base["made"] / base["attempts"], 2) if base["attempts"] else None,
        "scratch_rate": round(base["scratches"] / base["shots"], 2) if base["shots"] else None,
        "by_cut_angle": _rates(by(CUT_BUCKETS), "k"),
        "by_kind": _rates(by("kind"), "k"),
        "by_pocket": _rates(by("case when pocket like '%%side' then 'side' else 'corner' end"), "k"),
        "weekly": [{"week": r["week"].date().isoformat(), "attempts": r["attempts"],
                    "rate": round(r["made"] / r["attempts"], 2)} for r in weekly],
    }
