import { q } from "./db.mjs";

export const DIFFICULTIES = ["easy", "medium", "hard", "extreme"];

export async function getActive() {
  const r = await q(
    `SELECT * FROM challenges WHERE status='published' AND start_at <= now() AND end_at > now() ORDER BY start_at DESC LIMIT 1`
  );
  return r[0] || null;
}
export async function getUpcoming() {
  const r = await q(`SELECT * FROM challenges WHERE status='published' AND start_at > now() ORDER BY start_at ASC LIMIT 1`);
  return r[0] || null;
}
export async function getLastClosed() {
  const r = await q(`SELECT * FROM challenges WHERE status='published' AND end_at <= now() ORDER BY end_at DESC LIMIT 1`);
  return r[0] || null;
}
export async function getChallenge(id) {
  const r = await q(`SELECT * FROM challenges WHERE id=$1`, [id]);
  return r[0] || null;
}

/** Weekly leaderboard. Ties are broken by whoever reached their final score first (earned_at of their latest points). */
export async function leaderboard(challengeId) {
  const rows = await q(
    `SELECT u.id, u.nickname,
            COALESCE(SUM(pt.points),0)::int AS points,
            MAX(pt.earned_at) AS reached_at,
            (COUNT(DISTINCT pt.item_id) FILTER (WHERE pt.transaction_type='approval'))::int AS items
       FROM users u
       LEFT JOIN point_transactions pt ON pt.user_id = u.id AND pt.challenge_id = $1
      WHERE u.role='participant' AND u.status='active'
        AND u.created_at < (SELECT end_at FROM challenges WHERE id=$1)
      GROUP BY u.id, u.nickname
      ORDER BY points DESC, MAX(pt.earned_at) ASC NULLS LAST, lower(u.nickname)`,
    [challengeId]
  );
  let prev = null;
  return rows.map((r, i) => {
    const same = prev && prev.points === r.points && String(prev.reached_at) === String(r.reached_at);
    const rank = same ? prev.rank : i + 1;
    const out = { ...r, rank };
    prev = out;
    return out;
  });
}

/** Standings view for one user: rows + my rank, gap to the person above, etc. */
export async function standings(challenge, userId) {
  const rows = await leaderboard(challenge.id);
  const meIdx = rows.findIndex((r) => r.id === userId);
  let me = null;
  if (meIdx >= 0) {
    const m = rows[meIdx];
    const above = [...rows].reverse().find((r) => r.rank < m.rank);
    me = {
      rank: m.rank,
      points: m.points,
      items: m.items,
      above: above ? above.nickname : null,
      gap: above ? above.points - m.points + 1 : 0,
    };
  }
  return {
    rows: rows.map((r) => ({ rank: r.rank, nickname: r.nickname, points: r.points, items: r.items, me: r.id === userId })),
    me,
    total: rows.length,
  };
}

export async function userItems(challengeId, userId) {
  const rows = await q(
    `SELECT i.id, i.title, i.description, i.instructions, i.difficulty, i.points, i.hint, i.display_order,
            s.id AS sub_id, s.status AS sub_status, s.submitted_at, s.reviewed_at, s.rejection_reason,
            (SELECT count(*) FROM submissions x WHERE x.user_id=$2 AND x.item_id=i.id AND x.status='rejected')::int AS rejections
       FROM challenge_items i
       LEFT JOIN LATERAL (
         SELECT * FROM submissions s WHERE s.user_id=$2 AND s.item_id=i.id
          ORDER BY (s.status='approved') DESC, (s.status='pending') DESC, s.submitted_at DESC LIMIT 1
       ) s ON true
      WHERE i.challenge_id=$1
      ORDER BY i.display_order, i.id`,
    [challengeId, userId]
  );
  return rows.map((r) => ({
    id: r.id,
    number: 0,
    title: r.title,
    description: r.description,
    instructions: r.instructions,
    difficulty: r.difficulty,
    points: r.points,
    hint: r.hint,
    status: r.sub_status || "not_submitted",
    submission_id: r.sub_id,
    submitted_at: r.submitted_at,
    rejection_reason: r.sub_status === "rejected" ? r.rejection_reason : null,
    rejections: r.rejections,
  })).map((r, i) => ({ ...r, number: i + 1 }));
}
