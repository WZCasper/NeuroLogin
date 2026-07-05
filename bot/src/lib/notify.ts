import { Telegraf } from 'telegraf';
import { UserRecord } from './types';

function formatRecord(record: UserRecord): string {
  const lines = [
    `<b>Новая анкета подтверждена</b>`,
    `ID пользователя: <code>${record.userId}</code>`,
    record.username ? `Username: @${record.username}` : undefined,
    '',
    ...Object.values(record.answers).map((a) => `<b>${a.field}:</b> ${escapeHtml(a.value)}`),
    '',
    `Подтверждено: ${record.confirmedAt}`,
  ].filter(Boolean);
  return lines.join('\n');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Sends a copy of the confirmed record into the admin group, which acts as a
 * human-readable, append-only backup of the JSON data stored in the repo.
 */
export async function logToAdminGroup(bot: Telegraf, record: UserRecord): Promise<void> {
  const groupId = process.env.ADMIN_GROUP_ID;
  if (!groupId) return;

  try {
    const photoAnswer = Object.values(record.answers).find((a) => a.mediaPath);
    const text = formatRecord(record);

    if (photoAnswer?.mediaPath) {
      await bot.telegram.sendMessage(groupId, text, { parse_mode: 'HTML' });
    } else {
      await bot.telegram.sendMessage(groupId, text, { parse_mode: 'HTML' });
    }
  } catch (err) {
    console.error('Failed to log to admin group:', err);
  }
}
