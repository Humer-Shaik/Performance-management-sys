import { many, type Db } from "./db";

export async function notify(db: Db, userIds: (string | null | undefined)[], kind: string, entityType: string, entityId: string, body: string) {
  const unique = [...new Set(userIds.filter((u): u is string => !!u))];
  for (const userId of unique) {
    await db.query(
      "INSERT INTO notifications (user_id, kind, entity_type, entity_id, body) VALUES ($1, $2, $3, $4, $5)",
      [userId, kind, entityType, entityId, body],
    );
  }
}

export async function ownerIds(db: Db): Promise<string[]> {
  return (await many<{ user_id: string }>(db, "SELECT DISTINCT user_id FROM user_roles WHERE role = 'owner' AND valid_to IS NULL")).map((r) => r.user_id);
}
