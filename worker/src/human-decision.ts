export async function markHumanAction(
  db: D1Database,
  targetType: string,
  targetId: string,
  action: string,
): Promise<boolean> {
  try {
    await db.prepare(`
      INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed, last_human_action)
      VALUES (?, ?, 1, ?)
      ON CONFLICT(target_id) DO UPDATE SET
        ever_human_reviewed = 1,
        last_human_action = excluded.last_human_action
    `).bind(targetId, targetType, action).run();
    return true;
  } catch (error) {
    console.error('[markHumanAction] Failed to update moderation_targets:', error);
    return false;
  }
}

export async function markHumanReviewed(
  db: D1Database,
  targetType: string,
  targetId: string,
): Promise<boolean> {
  try {
    await db.prepare(`
      INSERT INTO moderation_targets (target_id, target_type, ever_human_reviewed)
      VALUES (?, ?, 1)
      ON CONFLICT(target_id) DO UPDATE SET ever_human_reviewed = 1
    `).bind(targetId, targetType).run();
    return true;
  } catch (error) {
    console.error('[markHumanReviewed] Failed to update moderation_targets:', error);
    return false;
  }
}
