//! Local cost history (checklist M1-33): one row per completed turn in `agentchainer.db` (SQLite, app data dir),
//! owned by the Rust core (ARCHITECTURE §7). Costs are the SDK's client-side estimates.

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::Mutex;

/// Bump with a new step in `migrate` when the schema changes.
const SCHEMA_VERSION: i64 = 1;

pub struct History {
    conn: Mutex<Connection>,
}

/// A completed turn, as the UI reports it. `total_cost_usd` is the session's running total.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    pub session_id: String,
    pub cwd: String,
    pub at: i64,
    pub total_cost_usd: f64,
    /// This turn's cost, when the UI knows it; otherwise derived from the session's previous recorded total.
    pub delta_usd: Option<f64>,
    pub duration_ms: i64,
    pub input_tokens: Option<i64>,
    pub output_tokens: Option<i64>,
    pub model: Option<String>,
    pub subtype: String,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionCost {
    pub session_id: String,
    pub total_cost_usd: f64,
    pub turns: i64,
    pub last_at: i64,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub today_usd: f64,
    pub last7_usd: f64,
    pub last30_usd: f64,
    /// Turns in the last 30 days whose own cost is unknown (the first turn of a session resumed from the terminal).
    pub uncounted_turns: i64,
}

impl History {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        Self::with(Connection::open(path).map_err(|e| e.to_string())?)
    }

    #[cfg(test)]
    pub fn in_memory() -> Self {
        Self::with(Connection::open_in_memory().unwrap()).unwrap()
    }

    fn with(conn: Connection) -> Result<Self, String> {
        migrate(&conn).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    pub fn record(&self, t: &TurnRecord) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let delta = match t.delta_usd {
            Some(d) => Some(d),
            None => conn
                .query_row(
                    "SELECT total_cost_usd FROM turns WHERE session_id = ?1 ORDER BY at DESC LIMIT 1",
                    params![t.session_id],
                    |r| r.get::<_, f64>(0),
                )
                .optional()
                .map_err(|e| e.to_string())?
                .map(|prev| (t.total_cost_usd - prev).max(0.0)),
        };
        conn.execute(
            "INSERT INTO turns (session_id, cwd, at, total_cost_usd, delta_usd, duration_ms, input_tokens, \
             output_tokens, model, subtype) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                t.session_id,
                t.cwd,
                t.at,
                t.total_cost_usd,
                delta,
                t.duration_ms,
                t.input_tokens,
                t.output_tokens,
                t.model,
                t.subtype
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// Each session's latest total in a workspace, most recent first.
    pub fn sessions(&self, cwd: &str) -> Result<Vec<SessionCost>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT session_id, \
                   (SELECT total_cost_usd FROM turns t2 WHERE t2.session_id = t.session_id ORDER BY at DESC LIMIT 1), \
                   COUNT(*), MAX(at) \
                 FROM turns t WHERE cwd = ?1 GROUP BY session_id ORDER BY MAX(at) DESC",
            )
            .map_err(|e| e.to_string())?;
        stmt.query_map(params![cwd], |r| {
            Ok(SessionCost {
                session_id: r.get(0)?,
                total_cost_usd: r.get(1)?,
                turns: r.get(2)?,
                last_at: r.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?
        .collect::<Result<_, _>>()
        .map_err(|e| e.to_string())
    }

    /// Spend in a workspace today (local time) and over the last 7 and 30 days, as of `now_ms`.
    pub fn summary(&self, cwd: &str, now_ms: i64) -> Result<Summary, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let day_ms = 86_400_000;
        conn.query_row(
            "SELECT \
               COALESCE(SUM(CASE WHEN date(at / 1000, 'unixepoch', 'localtime') = date(?2 / 1000, 'unixepoch', 'localtime') \
                 THEN delta_usd END), 0), \
               COALESCE(SUM(CASE WHEN at >= ?2 - 7 * ?3 THEN delta_usd END), 0), \
               COALESCE(SUM(delta_usd), 0), \
               COUNT(*) - COUNT(delta_usd) \
             FROM turns WHERE cwd = ?1 AND at >= ?2 - 30 * ?3",
            params![cwd, now_ms, day_ms],
            |r| {
                Ok(Summary {
                    today_usd: r.get(0)?,
                    last7_usd: r.get(1)?,
                    last30_usd: r.get(2)?,
                    uncounted_turns: r.get(3)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
    if version < 1 {
        conn.execute_batch(
            "CREATE TABLE turns (
               id INTEGER PRIMARY KEY,
               session_id TEXT NOT NULL,
               cwd TEXT NOT NULL,
               at INTEGER NOT NULL,
               total_cost_usd REAL NOT NULL,
               delta_usd REAL,
               duration_ms INTEGER NOT NULL,
               input_tokens INTEGER,
               output_tokens INTEGER,
               model TEXT,
               subtype TEXT NOT NULL
             );
             CREATE INDEX turns_by_cwd ON turns (cwd, at);
             CREATE INDEX turns_by_session ON turns (session_id, at);",
        )?;
    }
    conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION}"))
}

#[cfg(test)]
mod tests {
    use super::{History, SessionCost, TurnRecord};

    const DAY: i64 = 86_400_000;

    fn turn(session: &str, cwd: &str, at: i64, total: f64, delta: Option<f64>) -> TurnRecord {
        TurnRecord {
            session_id: session.into(),
            cwd: cwd.into(),
            at,
            total_cost_usd: total,
            delta_usd: delta,
            duration_ms: 1000,
            input_tokens: Some(10),
            output_tokens: Some(5),
            model: Some("haiku".into()),
            subtype: "success".into(),
        }
    }

    #[test]
    fn reports_each_sessions_latest_total_per_workspace() {
        let h = History::in_memory();
        let now = 100 * DAY;
        h.record(&turn("a", "/repo", now - 3000, 0.01, Some(0.01)))
            .unwrap();
        h.record(&turn("a", "/repo", now - 2000, 0.03, Some(0.02)))
            .unwrap();
        h.record(&turn("b", "/repo", now - 1000, 0.5, Some(0.5)))
            .unwrap();
        h.record(&turn("c", "/other", now, 9.0, Some(9.0))).unwrap();
        assert_eq!(
            h.sessions("/repo").unwrap(),
            vec![
                SessionCost {
                    session_id: "b".into(),
                    total_cost_usd: 0.5,
                    turns: 1,
                    last_at: now - 1000
                },
                SessionCost {
                    session_id: "a".into(),
                    total_cost_usd: 0.03,
                    turns: 2,
                    last_at: now - 2000
                },
            ]
        );
    }

    #[test]
    fn derives_an_unknown_turn_cost_from_the_sessions_previous_total() {
        let h = History::in_memory();
        let now = 100 * DAY;
        h.record(&turn("a", "/repo", now - 2000, 0.10, Some(0.10)))
            .unwrap();
        // Resumed later in a new tab: the UI doesn't know this turn's own cost, the history does.
        h.record(&turn("a", "/repo", now - 1000, 0.25, None))
            .unwrap();
        // A session first seen here, resumed from the terminal: its first turn stays uncounted.
        h.record(&turn("cli", "/repo", now, 1.0, None)).unwrap();
        let s = h.summary("/repo", now).unwrap();
        assert!((s.last7_usd - 0.25).abs() < 1e-9, "{s:?}");
        assert_eq!(s.uncounted_turns, 1);
    }

    #[test]
    fn sums_spend_by_window() {
        let h = History::in_memory();
        let now = 100 * DAY;
        h.record(&turn("a", "/repo", now - 40 * DAY, 5.0, Some(5.0)))
            .unwrap();
        h.record(&turn("b", "/repo", now - 10 * DAY, 2.0, Some(2.0)))
            .unwrap();
        h.record(&turn("c", "/repo", now - 2 * DAY, 1.0, Some(1.0)))
            .unwrap();
        h.record(&turn("d", "/repo", now, 0.5, Some(0.5))).unwrap();
        let s = h.summary("/repo", now).unwrap();
        assert_eq!((s.last7_usd, s.last30_usd), (1.5, 3.5));
        assert_eq!(s.today_usd, 0.5);
    }
}
